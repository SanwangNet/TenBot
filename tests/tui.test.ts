import assert from "node:assert/strict";
import test from "node:test";
import type { TenBotControl, ReloadResult } from "../src/control/tenbot-control.js";
import type { RuntimeStatus } from "../src/control/runtime-status.js";
import { handleTuiKey } from "../src/tui/key-handler.js";

function fakeControl(calls: string[], result: ReloadResult = { ok: true, message: "reloaded", loadedAt: "now" }): TenBotControl {
    const status: RuntimeStatus = {
        qq: "disconnected", provider: { id: "gpt", model: "test", webSearch: true, configured: false },
        activeCycles: 0, contextConversations: 0,
        memes: { count: 0, revision: 1, loadedAt: "now" },
        prompt: { provider: "gpt", revision: 1, loadedAt: "now" }, shuttingDown: false,
    };
    return {
        getStatus: () => status,
        subscribeStatus: () => () => undefined,
        subscribeLogs: () => () => undefined,
        async reloadPrompt() { calls.push("prompt"); return result; },
        async reloadMemes() { calls.push("memes"); return result; },
        async shutdown() { calls.push("shutdown"); },
    };
}

test("TUI shortcuts reload requested data and quit through Control shutdown", async () => {
    const calls: string[] = [];
    const messages: string[] = [];
    let quits = 0;
    const control = fakeControl(calls);
    await handleTuiKey("p", {}, control, (message) => messages.push(message), () => quits++);
    await handleTuiKey("m", {}, control, (message) => messages.push(message), () => quits++);
    await handleTuiKey("r", {}, control, (message) => messages.push(message), () => quits++);
    await handleTuiKey("q", {}, control, (message) => messages.push(message), () => quits++);
    assert.deepEqual(calls, ["prompt", "memes", "prompt", "memes", "shutdown"]);
    assert.deepEqual(messages, ["reloaded", "reloaded", "Runtime data reloaded"]);
    assert.equal(quits, 1);
});

test("TUI displays reload failures without throwing and Ctrl+C uses graceful shutdown", async () => {
    const calls: string[] = [];
    const messages: string[] = [];
    let quits = 0;
    const control = fakeControl(calls, { ok: false, message: "Reload failed; previous data kept" });
    await handleTuiKey("r", {}, control, (message) => messages.push(message), () => quits++);
    await handleTuiKey("c", { ctrl: true }, control, (message) => messages.push(message), () => quits++);
    assert.deepEqual(messages, ["One reload failed; its previous data was kept"]);
    assert.deepEqual(calls, ["prompt", "memes", "shutdown"]);
    assert.equal(quits, 1);
});
