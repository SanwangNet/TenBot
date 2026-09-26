import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createConfigStore } from "../src/config/config-store.js";
import { loadAppConfig, validatePublicConfigPatch } from "../src/config/config-validation.js";

async function withTempEnv(content: string, run: (envPath: string) => Promise<void>): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), "tenbot-config-"));
    const envPath = join(directory, ".env");
    try {
        await writeFile(envPath, content, "utf8");
        await run(envPath);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

test("ConfigStore patches only managed keys and preserves secrets, unknown fields, comments, blanks, and CRLF", async () => {
    await withTempEnv([
        "# TenBot",
        "CODEX_API_KEY=SECRET",
        "UNKNOWN_OPTION=abc",
        "",
        "AI_PROVIDER=gpt",
        "",
        "# comment",
        "BOT_LOG_LEVEL=info",
        "",
    ].join("\r\n"), async (envPath) => {
        const store = createConfigStore({ envPath, environment: {} });
        const result = await store.updatePublicConfig({ field: "aiProvider", value: "deepseek" });
        assert.equal(result.ok, true);
        const saved = await readFile(envPath, "utf8");
        assert.match(saved, /# TenBot\r\n/);
        assert.match(saved, /CODEX_API_KEY=SECRET\r\n/);
        assert.match(saved, /UNKNOWN_OPTION=abc\r\n/);
        assert.match(saved, /AI_PROVIDER=deepseek\r\n/);
        assert.match(saved, /# comment\r\nBOT_LOG_LEVEL=info\r\n/);
        assert.doesNotMatch(saved, /CODEX_REASONING_EFFORT/);
    });
});

test("ConfigStore rereads the file before saving and preserves external changes", async () => {
    await withTempEnv("AI_PROVIDER=gpt\n", async (envPath) => {
        const store = createConfigStore({ envPath, environment: {} });
        await writeFile(envPath, "AI_PROVIDER=gpt\nEXTERNAL_VALUE=yes\n", "utf8");
        const result = await store.updatePublicConfig({ field: "gpt.model", value: "gpt-6-sol" });
        assert.equal(result.ok, true);
        assert.match(await readFile(envPath, "utf8"), /EXTERNAL_VALUE=yes/);
    });
});

test("ConfigStore adds and removes automated peer IDs while preserving other env content", async () => {
    const original = "# private config\nCODEX_API_KEY=TOP_SECRET\nUNKNOWN_OPTION=keep\n\nAUTOMATED_PEER_IDS=a,b\n";
    await withTempEnv(original, async (envPath) => {
        const store = createConfigStore({ envPath, environment: {} });
        const added = await store.addAutomatedPeer(" c ");
        assert.deepEqual(added, { ok: true, changed: true, peerIds: ["a", "b", "c"], message: "自动账号已添加。" });
        assert.deepEqual((await store.addAutomatedPeer("b")).peerIds, ["a", "b", "c"]);
        const removed = await store.removeAutomatedPeer("b");
        assert.deepEqual(removed.peerIds, ["a", "c"]);
        const missing = await store.removeAutomatedPeer("not-registered");
        assert.equal(missing.ok, true);
        assert.equal(missing.changed, false);
        const saved = await readFile(envPath, "utf8");
        assert.match(saved, /# private config/);
        assert.match(saved, /CODEX_API_KEY=TOP_SECRET/);
        assert.match(saved, /UNKNOWN_OPTION=keep/);
        assert.match(saved, /AUTOMATED_PEER_IDS=a,c/);
        assert.deepEqual(store.getAutomatedPeerIds(), ["a", "c"]);
    });
});

test("ConfigStore automated peer mutations serialize concurrent updates and reject unsafe IDs", async () => {
    await withTempEnv("AUTOMATED_PEER_IDS=a\n", async (envPath) => {
        const store = createConfigStore({ envPath, environment: {} });
        const [first, second] = await Promise.all([store.addAutomatedPeer("b"), store.addAutomatedPeer("c")]);
        assert.equal(first.ok, true);
        assert.deepEqual(second.peerIds, ["a", "b", "c"]);
        const invalid = await store.addAutomatedPeer("bad,id");
        assert.equal(invalid.ok, false);
        assert.equal(invalid.peerIds.length, 3);
        assert.deepEqual(store.getAutomatedPeerIds(), ["a", "b", "c"]);
    });
});

test("registered automated peer IDs survive a new ConfigStore instance and do not depend on recent peers", async () => {
    await withTempEnv("AI_PROVIDER=gpt\n", async (envPath) => {
        const firstRuntimeStore = createConfigStore({ envPath, environment: {} });
        const added = await firstRuntimeStore.addAutomatedPeer("stable-peer-a");
        assert.equal(added.ok, true);
        const afterRestart = createConfigStore({ envPath, environment: {} });
        assert.deepEqual(afterRestart.getAutomatedPeerIds(), ["stable-peer-a"]);
    });
});

test("ConfigStore automated peer mutations re-read external changes before saving", async () => {
    await withTempEnv("AUTOMATED_PEER_IDS=a\n", async (envPath) => {
        const store = createConfigStore({ envPath, environment: {} });
        await writeFile(envPath, "AUTOMATED_PEER_IDS=a\nEXTERNAL_VALUE=yes\n", "utf8");
        const result = await store.addAutomatedPeer("b");
        assert.equal(result.ok, true);
        assert.match(await readFile(envPath, "utf8"), /EXTERNAL_VALUE=yes/);
        assert.deepEqual(result.peerIds, ["a", "b"]);
    });
});

test("ConfigStore appends new managed keys and serializes concurrent writes", async () => {
    await withTempEnv("AI_PROVIDER=gpt\n", async (envPath) => {
        const store = createConfigStore({ envPath, environment: {} });
        const results = await Promise.all([
            store.updatePublicConfig({ field: "botLoopGuard.maxCycles", value: 6 }),
            store.updatePublicConfig({ field: "gpt.reasoningEffort", value: "xhigh" }),
        ]);
        assert.ok(results.every((result) => result.ok));
        const saved = await readFile(envPath, "utf8");
        assert.match(saved, /BOT_LOOP_GUARD_MAX_CYCLES=6/);
        assert.match(saved, /CODEX_REASONING_EFFORT=xhigh/);
    });
});

test("public config exposes only safe metadata and shared defaults parse provider settings", () => {
    const config = loadAppConfig({
        AI_PROVIDER: "gpt",
        CODEX_API_KEY: "SECRET_API_KEY",
        CODEX_BASE_URL: "https://secret.example",
        CODEX_MODEL: "gpt-test",
        CODEX_REASONING_EFFORT: "low",
        CODEX_VERBOSITY: "medium",
        DEEPSEEK_API_KEY: "DEEP_SECRET",
        BOT_LOG_LEVEL: "debug",
        BOT_LOOP_GUARD_MAX_CYCLES: "10",
        AUTOMATED_PEER_IDS: "A,B,A",
    });
    const publicConfig = createConfigStore({
        envPath: join(tmpdir(), "tenbot-config-missing.env"),
        environment: {
            AI_PROVIDER: "gpt",
            CODEX_API_KEY: "SECRET_API_KEY",
            CODEX_BASE_URL: "https://secret.example",
            CODEX_MODEL: "gpt-test",
            CODEX_REASONING_EFFORT: "low",
            CODEX_VERBOSITY: "medium",
            DEEPSEEK_API_KEY: "DEEP_SECRET",
            BOT_LOG_LEVEL: "debug",
            BOT_LOOP_GUARD_MAX_CYCLES: "10",
            AUTOMATED_PEER_IDS: "A,B,A",
        },
    }).getPublicConfig();
    assert.equal(config.ai.gpt.model, "gpt-test");
    assert.equal(publicConfig.gpt.configured, true);
    assert.equal(publicConfig.deepseek.configured, true);
    assert.equal(publicConfig.botLoopGuard.automatedPeerCount, 2);
    assert.equal(publicConfig.logLevel, "debug");
    assert.doesNotMatch(JSON.stringify(publicConfig), /SECRET_API_KEY|DEEP_SECRET|secret\.example/);
});

test("Front mode defaults to legacy and does not require Reply Judge configuration", () => {
    const config = loadAppConfig({ AI_PROVIDER: "gpt" });
    assert.equal(config.frontMode, "legacy");
    assert.equal(config.replyJudge.provider, undefined);
    assert.equal(config.replyJudge.model, "");
    assert.equal(config.replyJudge.apiKey, undefined);
    assert.equal(loadAppConfig({ FRONT_MODE: "legacy", REPLY_JUDGE_PROVIDER: "unused-invalid-provider" }).frontMode, "legacy");
});

test("judge Front mode validates its independent provider configuration at load time", () => {
    assert.throws(() => loadAppConfig({ FRONT_MODE: "judge" }), /REPLY_JUDGE_PROVIDER.*REPLY_JUDGE_MODEL.*REPLY_JUDGE_BASE_URL.*REPLY_JUDGE_API_KEY/);
    const config = loadAppConfig({
        FRONT_MODE: "judge",
        REPLY_JUDGE_PROVIDER: "openai-compatible",
        REPLY_JUDGE_MODEL: "judge-test",
        REPLY_JUDGE_BASE_URL: "https://judge.example/v1",
        REPLY_JUDGE_API_KEY: "secret",
    });
    assert.equal(config.frontMode, "judge");
    assert.equal(config.replyJudge.provider, "openai-compatible");
    assert.equal(config.replyJudge.model, "judge-test");
    assert.equal(config.replyJudge.timeoutMs, 5_000);
    assert.throws(() => loadAppConfig({ FRONT_MODE: "typo" }), /FRONT_MODE/);
});

test("ConfigStore reload parsing follows current disk values instead of stale dotenv values", async () => {
    await withTempEnv("AI_PROVIDER=gpt\nCODEX_MODEL=gpt-old\n", async (envPath) => {
        const store = createConfigStore({ envPath, environment: { AI_PROVIDER: "gpt", CODEX_MODEL: "gpt-old" } });
        await writeFile(envPath, "AI_PROVIDER=deepseek\nDEEPSEEK_MODEL=deepseek-new\n", "utf8");
        const config = store.getAppConfig();
        assert.equal(config.ai.provider, "deepseek");
        assert.equal(config.ai.deepseek.model, "deepseek-new");
        assert.equal(config.ai.gpt.model, "gpt-6-sol", "removed .env keys do not survive in a stale process.env snapshot");
    });
});

test("ConfigStore rejects unsafe model names and invalid guard, reasoning, verbosity, and log values", async () => {
    assert.throws(() => validatePublicConfigPatch({ field: "gpt.model", value: "   " }), /模型名称/);
    assert.throws(() => validatePublicConfigPatch({ field: "gpt.model", value: "bad\nname" }), /模型名称/);
    assert.throws(() => validatePublicConfigPatch({ field: "botLoopGuard.maxCycles", value: 0 }), />=|大于等于/);
    assert.throws(() => validatePublicConfigPatch({ field: "botLoopGuard.maxCycles", value: 1.5 }), />=|大于等于/);
    assert.throws(() => validatePublicConfigPatch({ field: "gpt.reasoningEffort", value: "turbo" as never }), /推理强度/);
    assert.throws(() => validatePublicConfigPatch({ field: "gpt.verbosity", value: "verbose" as never }), /输出详细度/);
    assert.throws(() => validatePublicConfigPatch({ field: "logLevel", value: "warn" as never }), /日志级别/);
});

test("ConfigStore returns a safe failure and leaves the old file unchanged when writing fails", async () => {
    await withTempEnv("AI_PROVIDER=gpt\n", async (envPath) => {
        const store = createConfigStore({
            envPath,
            environment: {},
            writeFileAtomically: async () => { throw Object.assign(new Error("secret should not escape"), { code: "EACCES" }); },
        });
        const result = await store.updatePublicConfig({ field: "aiProvider", value: "deepseek" });
        assert.equal(result.ok, false);
        assert.match(result.message, /无法写入/);
        assert.doesNotMatch(JSON.stringify(result), /secret should not escape/);
        assert.equal(await readFile(envPath, "utf8"), "AI_PROVIDER=gpt\n");
    });
});
