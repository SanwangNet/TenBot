import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createConfigStore } from "../src/config/config-store.js";
import { loadAppConfig, parsePublicConfigPatch, validatePublicConfigPatch } from "../src/config/config-validation.js";

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
            REPLY_JUDGE_PROVIDER: "openai-compatible",
            REPLY_JUDGE_MODEL: "Qwen/Qwen3.5-4B",
            REPLY_JUDGE_BASE_URL: "https://judge-secret.example/v1",
            REPLY_JUDGE_API_KEY: "JUDGE_SECRET",
            REPLY_JUDGE_TIMEOUT_MS: "15000",
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
    assert.deepEqual(publicConfig.replyJudge, { model: "Qwen/Qwen3.5-4B", timeoutMs: 15_000, fallbackToMainOnInvalidOutput: true, turnWaitMs: 20_000, provider: "openai-compatible" });
    assert.doesNotMatch(JSON.stringify(publicConfig), /SECRET_API_KEY|DEEP_SECRET|JUDGE_SECRET|judge-secret\.example/);
});

test("Reply Judge config patches map to their env keys and validate safe model IDs and timeout bounds", async () => {
    assert.equal(validatePublicConfigPatch({ field: "replyJudge.model", value: " Qwen/Qwen3.5-4B " }), "REPLY_JUDGE_MODEL");
    assert.equal(validatePublicConfigPatch({ field: "replyJudge.model", value: "THUDM/GLM-4-9B-0414" }), "REPLY_JUDGE_MODEL");
    assert.throws(() => validatePublicConfigPatch({ field: "replyJudge.model", value: "  " }), /模型名称/);
    assert.throws(() => validatePublicConfigPatch({ field: "replyJudge.model", value: "model\nnext" }), /模型名称/);
    assert.throws(() => validatePublicConfigPatch({ field: "replyJudge.model", value: "m".repeat(129) }), /模型名称/);

    for (const timeoutMs of [1_000, 5_000, 15_000, 30_000]) {
        assert.equal(validatePublicConfigPatch({ field: "replyJudge.timeoutMs", value: timeoutMs }), "REPLY_JUDGE_TIMEOUT_MS");
    }
    for (const turnWaitMs of [1_000, 20_000, 60_000]) {
        assert.equal(validatePublicConfigPatch({ field: "replyJudge.turnWaitMs", value: turnWaitMs }), "REPLY_JUDGE_TURN_WAIT_MS");
    }
    for (const turnWaitMs of [0, 999, 60_001, 1_500.5, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => validatePublicConfigPatch({ field: "replyJudge.turnWaitMs", value: turnWaitMs }), /1000 and 60000/);
    }
    for (const timeoutMs of [999, 30_001, 1_500.5, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => validatePublicConfigPatch({ field: "replyJudge.timeoutMs", value: timeoutMs }), /1000 到 30000/);
    }

    await withTempEnv("FRONT_MODE=legacy\n", async (envPath) => {
        const store = createConfigStore({ envPath, environment: {} });
        assert.equal((await store.updatePublicConfig({ field: "replyJudge.model", value: "Qwen/Qwen3.5-4B" })).ok, true);
        assert.equal((await store.updatePublicConfig({ field: "replyJudge.timeoutMs", value: 15_000 })).ok, true);
        assert.equal((await store.updatePublicConfig({ field: "replyJudge.turnWaitMs", value: 25_000 })).ok, true);
        const saved = await readFile(envPath, "utf8");
        assert.match(saved, /REPLY_JUDGE_MODEL=Qwen\/Qwen3\.5-4B/);
        assert.match(saved, /REPLY_JUDGE_TIMEOUT_MS=15000/);
        assert.match(saved, /REPLY_JUDGE_TURN_WAIT_MS=25000/);
        assert.deepEqual(store.getPublicConfig().replyJudge, { model: "Qwen/Qwen3.5-4B", timeoutMs: 15_000, fallbackToMainOnInvalidOutput: true, turnWaitMs: 25_000 });
        assert.equal((await store.updatePublicConfig({ field: "replyJudge.fallbackToMainOnInvalidOutput", value: false })).ok, true);
        assert.match(await readFile(envPath, "utf8"), /REPLY_JUDGE_IPO_FALLBACK_TO_MAIN=false/);
        assert.equal(store.getPublicConfig().replyJudge.fallbackToMainOnInvalidOutput, false);
    });
});

test("Front mode defaults to legacy and does not require Reply Judge configuration", () => {
    const config = loadAppConfig({ AI_PROVIDER: "gpt" });
    assert.equal(config.frontMode, "legacy");
    assert.equal(config.replyJudge.provider, undefined);
    assert.equal(config.replyJudge.model, "");
    assert.equal(config.replyJudge.apiKey, undefined);
    assert.equal(config.replyJudge.fallbackToMainOnInvalidOutput, true);
    assert.equal(config.replyJudge.turnWaitMs, 20_000);
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
    assert.equal(config.replyJudge.fallbackToMainOnInvalidOutput, true);
    assert.equal(config.replyJudge.turnWaitMs, 20_000);
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

test("Reply Judge IPO fallback strictly parses boolean config and public patches", () => {
    assert.equal(loadAppConfig({}).replyJudge.fallbackToMainOnInvalidOutput, true);
    assert.equal(loadAppConfig({ REPLY_JUDGE_IPO_FALLBACK_TO_MAIN: "true" }).replyJudge.fallbackToMainOnInvalidOutput, true);
    assert.equal(loadAppConfig({ REPLY_JUDGE_IPO_FALLBACK_TO_MAIN: "false" }).replyJudge.fallbackToMainOnInvalidOutput, false);
    assert.equal(loadAppConfig({ REPLY_JUDGE_IPO_FALLBACK_TO_MAIN: " FALSE " }).replyJudge.fallbackToMainOnInvalidOutput, false);
    assert.throws(() => loadAppConfig({ REPLY_JUDGE_IPO_FALLBACK_TO_MAIN: "enabled" }), /REPLY_JUDGE_IPO_FALLBACK_TO_MAIN/);

    const patch = { field: "replyJudge.fallbackToMainOnInvalidOutput", value: false } as const;
    assert.deepEqual(parsePublicConfigPatch(patch), patch);
    assert.equal(parsePublicConfigPatch({ field: patch.field, value: "false" }), undefined);
    assert.equal(validatePublicConfigPatch(patch), "REPLY_JUDGE_IPO_FALLBACK_TO_MAIN");
    assert.throws(() => validatePublicConfigPatch({ field: patch.field, value: "false" } as never), /must be true or false/);
});

test("Reply Judge turn wait defaults to 20 seconds and validates env and public patch bounds", () => {
    assert.equal(loadAppConfig({}).replyJudge.turnWaitMs, 20_000);
    assert.equal(loadAppConfig({ REPLY_JUDGE_TURN_WAIT_MS: "20000" }).replyJudge.turnWaitMs, 20_000);
    assert.equal(loadAppConfig({ REPLY_JUDGE_TURN_WAIT_MS: "1000" }).replyJudge.turnWaitMs, 1_000);
    assert.equal(loadAppConfig({ REPLY_JUDGE_TURN_WAIT_MS: "60000" }).replyJudge.turnWaitMs, 60_000);
    for (const value of ["0", "999", "60001", "1.5", "20s", "-1"]) {
        assert.throws(() => loadAppConfig({ REPLY_JUDGE_TURN_WAIT_MS: value }), /REPLY_JUDGE_TURN_WAIT_MS/);
    }
    const patch = { field: "replyJudge.turnWaitMs", value: 20_000 } as const;
    assert.deepEqual(parsePublicConfigPatch(patch), patch);
    assert.equal(parsePublicConfigPatch({ field: patch.field, value: "20000" }), undefined);
    assert.equal(validatePublicConfigPatch(patch), "REPLY_JUDGE_TURN_WAIT_MS");
});

test("Web host and port use secure defaults and accept explicit valid values", () => {
    const defaults = loadAppConfig({});
    assert.deepEqual(defaults.web, { host: "127.0.0.1", port: 3000 });

    for (const host of ["localhost", "127.0.0.1", "0.0.0.0", "::1"]) {
        assert.equal(loadAppConfig({ WEB_HOST: host }).web.host, host);
    }
    for (const port of [1, 3000, 8080, 65_535]) {
        assert.equal(loadAppConfig({ WEB_PORT: String(port) }).web.port, port);
    }
});

test("Web port rejects values outside the integer range without falling back", () => {
    for (const port of ["0", "65536", "-1", "1.5", "abc"]) {
        assert.throws(() => loadAppConfig({ WEB_PORT: port }), /WEB_PORT/);
    }
});

test("Web host rejects malformed bind addresses", () => {
    for (const host of ["0.0.0.0:3000", "bad host", "bad/host"]) {
        assert.throws(() => loadAppConfig({ WEB_HOST: host }), /WEB_HOST/);
    }
});
