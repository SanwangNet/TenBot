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
