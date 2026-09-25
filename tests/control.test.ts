import assert from "node:assert/strict";
import test from "node:test";
import { createTenBotControl } from "../src/control/tenbot-control.js";
import type { RuntimeStatus } from "../src/control/runtime-status.js";
import { LogBuffer } from "../src/control/log-buffer.js";
import { MAX_TUI_LOG_ENTRIES } from "../src/control/tenbot-control.js";
import { logger, setConsoleLogOutputEnabled } from "../src/shared/logger.js";
import type { PublicConfig } from "../src/config/config-types.js";

const status: RuntimeStatus = {
    qq: "connected",
    provider: { id: "deepseek", model: "deepseek-flash", webSearch: false, configured: true },
    activeCycles: 1,
    contextConversations: 2,
    memes: { count: 95, revision: 1, loadedAt: "2026-01-01T00:00:00.000Z" },
    prompt: { provider: "deepseek", revision: 1, loadedAt: "2026-01-01T00:00:00.000Z" },
    shuttingDown: false,
};
const config: PublicConfig = {
    aiProvider: "deepseek",
    gpt: { model: "gpt-6-sol", reasoningEffort: "high", verbosity: "high", configured: false },
    deepseek: { model: "deepseek-flash", reasoningEffort: "high", configured: true },
    logLevel: "info",
    botLoopGuard: { maxCycles: 4, automatedPeerCount: 0 },
};

test("Control exposes only serializable Runtime status and supports subscriptions", async () => {
    let current = structuredClone(status);
    let shutdowns = 0;
    const control = createTenBotControl({
        getStatus: () => current,
        getConfig: () => config,
        async updateConfig() { return { ok: true, requiresRestart: true, changedFields: ["aiProvider"], message: "saved" }; },
        getAutomatedPeers: () => [],
        getRecentPeers: () => [],
        async addAutomatedPeer() { return { ok: true, changed: true, message: "added" }; },
        async removeAutomatedPeer() { return { ok: true, changed: true, message: "removed" }; },
        async reloadPrompt() { return { ok: true, message: "Prompt reloaded", loadedAt: "2026-01-01T00:00:00.000Z" }; },
        async reloadMemes() { return { ok: true, message: "Memes reloaded", loadedAt: "2026-01-01T00:00:00.000Z" }; },
        async shutdown() { shutdowns++; },
        subscribeLogs: () => () => undefined,
    });
    const first = control.getStatus();
    assert.equal(first.provider.id, "deepseek");
    assert.doesNotMatch(JSON.stringify(first), /secret|api.?key|authorization|cookie/i);
    assert.doesNotThrow(() => JSON.stringify(first));

    const observed: string[] = [];
    const unsubscribe = control.subscribeStatus((value) => observed.push(value.qq));
    current.qq = "disconnected";
    control.publishStatus();
    unsubscribe();
    current.qq = "error";
    control.publishStatus();
    assert.deepEqual(observed, ["connected", "disconnected"]);
    const events: string[] = [];
    const unsubscribeEvent = control.subscribeEvents((event) => { if (event.type === "provider-error") events.push(event.notice.provider); });
    control.publishEvent({
        type: "provider-error",
        notice: { provider: "deepseek", model: "deepseek-flash", status: 503, retryable: true, message: "暂时不可用", timestamp: "now" },
    });
    unsubscribeEvent();
    assert.deepEqual(events, ["deepseek"]);
    await control.shutdown();
    assert.equal(shutdowns, 1);
});

test("LogBuffer streams structured logs and drops the oldest entries at its limit", () => {
    const previousConsole = console.error;
    const buffer = new LogBuffer(2);
    const received: string[] = [];
    const unsubscribe = buffer.subscribe((entry) => received.push(entry.text));
    setConsoleLogOutputEnabled(false);
    console.error = () => undefined;
    try {
        logger.error("buffer-one");
        logger.error("buffer-two");
        logger.error("buffer-three");
        assert.deepEqual(buffer.getEntries().map((entry) => entry.text), ["buffer-two", "buffer-three"]);
        assert.equal(buffer.getEntries()[0]?.timestamp.length, 24);
        assert.equal(received.length, 3);
        unsubscribe();
        logger.error("buffer-four");
        assert.equal(received.length, 3);
    } finally {
        console.error = previousConsole;
        setConsoleLogOutputEnabled(true);
        buffer.dispose();
    }
    assert.equal(MAX_TUI_LOG_ENTRIES, 400);
});

test("plain logger mode continues to write to console", () => {
    const previousConsole = console.error;
    let output = "";
    console.error = (value?: unknown) => { output = String(value); };
    setConsoleLogOutputEnabled(true);
    try { logger.error("plain sink check"); }
    finally { console.error = previousConsole; }
    assert.match(output, /plain sink check/);
});
