import assert from "node:assert/strict";
import test from "node:test";
import type { TenBotControl, ReloadResult } from "../src/control/tenbot-control.js";
import type { RuntimeStatus } from "../src/control/runtime-status.js";
import { handleTuiKey } from "../src/tui/key-handler.js";
import { createProviderErrorNotice } from "../src/control/provider-error.js";
import { connectionLabel, formatTuiLogText, reasoningLabel, verbosityLabel } from "../src/tui/i18n.js";
import { closeModal, receiveProviderError } from "../src/tui/app.js";
import { clampLogOffset, initialTuiState, moveSidebarSelection } from "../src/tui/state.js";
import { supportsInteractiveTui } from "../src/tui/terminal-check.js";

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
        subscribeEvents: () => () => undefined,
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
    assert.deepEqual(messages, ["reloaded", "reloaded", "提示词和梗数据已重载"]);
    assert.equal(quits, 1);
});

test("TUI displays reload failures without throwing and Ctrl+C uses graceful shutdown", async () => {
    const calls: string[] = [];
    const messages: string[] = [];
    let quits = 0;
    const control = fakeControl(calls, { ok: false, message: "Reload failed; previous data kept" });
    await handleTuiKey("r", {}, control, (message) => messages.push(message), () => quits++);
    await handleTuiKey("c", { ctrl: true }, control, (message) => messages.push(message), () => quits++);
    assert.deepEqual(messages, ["部分重载失败；已保留旧版本"]);
    assert.deepEqual(calls, ["prompt", "memes", "shutdown"]);
    assert.equal(quits, 1);
});

test("TUI localizes status values and log scopes without changing plain logger text", () => {
    assert.equal(connectionLabel("connected"), "已连接");
    assert.equal(connectionLabel("disconnected"), "未连接");
    assert.equal(connectionLabel("error"), "异常");
    assert.equal(reasoningLabel("high"), "高");
    assert.equal(reasoningLabel("xhigh"), "极高");
    assert.equal(reasoningLabel(undefined), "默认");
    assert.equal(verbosityLabel("low"), "简洁");
    assert.equal(verbosityLabel(undefined), "默认");
    assert.equal(formatTuiLogText({ timestamp: "now", level: "info", text: "[GROUP] [Cycle] [AI] [Unknown]" }), "[群聊] [周期] [模型] [Unknown]");
});

test("sidebar and log navigation clamp to usable bounds", () => {
    assert.equal(moveSidebarSelection("overview", 1, ["overview", "model", "logs"]), "model");
    assert.equal(moveSidebarSelection("overview", -1, ["overview", "model", "logs"]), "overview");
    assert.equal(moveSidebarSelection("logs", 1, ["overview", "model", "logs"]), "logs");
    assert.equal(clampLogOffset(30, 20, 5), 15);
    assert.equal(clampLogOffset(-1, 20, 5), 0);
});

test("provider error notice is structured and redacts credentials and headers", () => {
    const cause = Object.assign(new Error("Authorization: Bearer super-secret api_key=sk-live-secret"), {
        status: 503,
        code: "service_unavailable",
        retryable: true,
        headers: { authorization: "Bearer super-secret", cookie: "session-secret" },
    });
    const error = Object.assign(new Error("gpt provider request failed"), { cause });
    const notice = createProviderErrorNotice("gpt", "gpt-6-sol", error);
    assert.deepEqual({ provider: notice.provider, model: notice.model, status: notice.status, code: notice.code, retryable: notice.retryable }, {
        provider: "gpt", model: "gpt-6-sol", status: 503, code: "service_unavailable", retryable: true,
    });
    assert.doesNotMatch(JSON.stringify(notice), /super-secret|sk-live-secret|authorization|api[_ -]?key|cookie/i);
    assert.match(notice.message, /redacted|失败|service/i);
});

test("provider errors open one modal and queue subsequent errors", () => {
    const first = { provider: "gpt", model: "gpt-6-sol", message: "暂时不可用", timestamp: "now" };
    const second = { provider: "gpt", model: "gpt-6-sol", message: "再次失败", timestamp: "later" };
    const opened = receiveProviderError(initialTuiState, first);
    assert.equal(opened.modal.type, "provider-error");
    const queued = receiveProviderError({ ...opened, modal: { type: "help" } }, second);
    assert.equal(queued.queuedProviderError?.notice.message, "再次失败");
    const next = closeModal(queued);
    assert.equal(next.modal.type, "provider-error");
    if (next.modal.type === "provider-error") assert.equal(next.modal.notice.message, "再次失败");
});

test("TUI refuses non-TTY streams before rendering", () => {
    assert.equal(supportsInteractiveTui({ isTTY: true }, { isTTY: true }), true);
    assert.equal(supportsInteractiveTui({ isTTY: false }, { isTTY: true }), false);
    assert.equal(supportsInteractiveTui({ isTTY: true }, { isTTY: false }), false);
});
