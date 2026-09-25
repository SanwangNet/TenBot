import assert from "node:assert/strict";
import test from "node:test";
import type { TenBotControl, ReloadResult } from "../src/control/tenbot-control.js";
import type { RuntimeStatus } from "../src/control/runtime-status.js";
import type { PublicConfig } from "../src/config/config-types.js";
import { handleTuiKey } from "../src/tui/key-handler.js";
import { createProviderErrorNotice } from "../src/control/provider-error.js";
import { connectionLabel, formatTuiLogText, reasoningLabel, verbosityLabel } from "../src/tui/i18n.js";
import { closeModal, hasPendingRestart, openConfigModal, receiveProviderError, textPatch } from "../src/tui/app.js";
import { activateSidebarPage, clampLogOffset, handleLogsNavigation, initialTuiState, moveSettingsSelection, moveSidebarSelection, quitConfirmationAction, requestQuitConfirmation, toggleTuiFocus } from "../src/tui/state.js";
import { supportsInteractiveTui } from "../src/tui/terminal-check.js";
import { ClickableRegionRegistry, SgrMouseParser, TerminalMouseSession } from "../src/tui/mouse-input.js";

function fakeControl(calls: string[], result: ReloadResult = { ok: true, message: "reloaded", loadedAt: "now" }): TenBotControl {
    const status: RuntimeStatus = {
        qq: "disconnected", provider: { id: "gpt", model: "test", webSearch: true, configured: false },
        activeCycles: 0, contextConversations: 0,
        memes: { count: 0, revision: 1, loadedAt: "now" },
        prompt: { provider: "gpt", revision: 1, loadedAt: "now" }, shuttingDown: false,
    };
    const config: PublicConfig = {
        aiProvider: "gpt",
        gpt: { model: "test", reasoningEffort: "high", verbosity: "high", configured: false },
        deepseek: { model: "deepseek-flash", reasoningEffort: "high", configured: false },
        logLevel: "info",
        botLoopGuard: { maxCycles: 4, automatedPeerCount: 0 },
    };
    return {
        getStatus: () => status,
        getConfig: () => config,
        async updateConfig() { return { ok: true, requiresRestart: true, changedFields: [], message: "saved" }; },
        getAutomatedPeers: () => [],
        getRecentPeers: () => [],
        async addAutomatedPeer() { return { ok: true, changed: true, message: "added" }; },
        async removeAutomatedPeer() { return { ok: true, changed: true, message: "removed" }; },
        subscribeStatus: () => () => undefined,
        subscribeLogs: () => () => undefined,
        subscribeEvents: () => () => undefined,
        async reloadPrompt() { calls.push("prompt"); return result; },
        async reloadMemes() { calls.push("memes"); return result; },
        async shutdown() { calls.push("shutdown"); },
    };
}

test("TUI shortcuts reload requested data and Q requests a confirmation", async () => {
    const calls: string[] = [];
    const messages: string[] = [];
    let quits = 0;
    const control = fakeControl(calls);
    await handleTuiKey("p", {}, control, (message) => messages.push(message), () => quits++);
    await handleTuiKey("m", {}, control, (message) => messages.push(message), () => quits++);
    await handleTuiKey("r", {}, control, (message) => messages.push(message), () => quits++);
    await handleTuiKey("q", {}, control, (message) => messages.push(message), () => quits++);
    assert.deepEqual(calls, ["prompt", "memes", "prompt", "memes"]);
    assert.deepEqual(messages, ["reloaded", "reloaded", "提示词和梗数据已重载"]);
    assert.equal(quits, 1);
});

test("TUI displays reload failures and Ctrl+C requests a confirmation", async () => {
    const calls: string[] = [];
    const messages: string[] = [];
    let quits = 0;
    const control = fakeControl(calls, { ok: false, message: "Reload failed; previous data kept" });
    await handleTuiKey("r", {}, control, (message) => messages.push(message), () => quits++);
    await handleTuiKey("c", { ctrl: true }, control, (message) => messages.push(message), () => quits++);
    assert.deepEqual(messages, ["部分重载失败；已保留旧版本"]);
    assert.deepEqual(calls, ["prompt", "memes"]);
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
    assert.equal(moveSettingsSelection(0, -1), 0);
    assert.equal(moveSettingsSelection(0, 1, 3), 1);
    assert.equal(moveSettingsSelection(2, 1, 3), 2);
    const clicked = activateSidebarPage(initialTuiState, "logs");
    assert.equal(clicked.page, "logs");
    assert.equal(clicked.selectedPage, "logs");
    assert.equal(clicked.focus, "main");
});

test("Tab switches focus in Logs in both directions without consuming log navigation", () => {
    const inLogs = { ...initialTuiState, page: "logs" as const, focus: "main" as const };
    const backToSidebar = toggleTuiFocus(inLogs);
    assert.equal(backToSidebar.focus, "sidebar");
    assert.equal(backToSidebar.page, "logs");
    const backToMain = toggleTuiFocus(backToSidebar);
    assert.equal(backToMain.focus, "main");
    assert.equal(backToMain.page, "logs");
    const pageUp = handleLogsNavigation({ ...backToMain, logOffset: 0 }, { pageUp: true }, 30, 5);
    assert.equal(pageUp.handled, true);
    assert.equal(pageUp.state.logOffset, 5);
    const pageDown = handleLogsNavigation(pageUp.state, { pageDown: true }, 30, 5);
    assert.equal(pageDown.state.logOffset, 0);
    const home = handleLogsNavigation({ ...backToMain, logOffset: 0 }, { home: true }, 30, 5);
    assert.equal(home.state.logOffset, 25);
    const end = handleLogsNavigation(home.state, { end: true }, 30, 5);
    assert.equal(end.state.logOffset, 0);
    assert.equal(handleLogsNavigation(backToSidebar, { pageUp: true }, 30, 5).handled, false);
    assert.equal(clampLogOffset(100, 30, 5), 25);
});

test("Q and Ctrl+C open a single quit confirmation; only Enter confirms", () => {
    const first = requestQuitConfirmation({ ...initialTuiState, focus: "main" });
    assert.equal(first.modal.type, "quit-confirm");
    assert.equal(requestQuitConfirmation(first), first, "repeated Q keeps the current confirmation");
    assert.equal(quitConfirmationAction(first, {}), undefined);
    assert.equal(quitConfirmationAction(first, { escape: true }), "cancel");
    assert.equal(quitConfirmationAction(first, { return: true }), "confirm");
});

test("SGR mouse parser accepts only left presses and converts terminal coordinates", () => {
    const parser = new SgrMouseParser();
    assert.deepEqual(parser.feed("\u001b[<0;8;4"), []);
    assert.deepEqual(parser.feed("M"), [{ x: 7, y: 3, button: "left" }]);
    assert.deepEqual(parser.feed("\u001b[<0;8;4m\u001b[<1;2;3M\u001b[<64;2;3M\u001b[<0;0;1M"), []);
    assert.deepEqual(parser.feed("bad input"), []);
});

test("mouse session enables SGR click mode and disables it once on cleanup", () => {
    const writes: string[] = [];
    const output = { isTTY: true, write(value: string) { writes.push(value); } };
    const session = new TerminalMouseSession(output);
    const clicks: unknown[] = [];
    session.subscribe((click) => clicks.push(click));
    assert.equal(session.enter(), true);
    assert.equal(session.handleInput("\u001b[<0;3;5M"), true);
    assert.equal(session.handleInput("\u001b[<0;3;5m"), true);
    assert.equal(session.handleInput("[<0;4;6M"), true, "Ink strips an escape prefix from unknown input sequences");
    session.leave();
    session.leave();
    assert.deepEqual(clicks, [{ x: 2, y: 4, button: "left" }, { x: 3, y: 5, button: "left" }]);
    assert.deepEqual(writes, ["\u001b[?1000h\u001b[?1006h", "\u001b[?1006l\u001b[?1000l"]);
});

test("clickable regions dispatch current bounds and clearing invalidates resized coordinates", () => {
    const registry = new ClickableRegionRegistry();
    let clicked = 0;
    registry.register({ id: "logs", x: 5, y: 4, width: 10, height: 1, action: () => clicked++ });
    assert.equal(registry.dispatch({ x: 6, y: 4, button: "left" }), true);
    assert.equal(clicked, 1);
    registry.clear();
    assert.equal(registry.dispatch({ x: 6, y: 4, button: "left" }), false);
    registry.register({ id: "logs", x: 2, y: 8, width: 10, height: 1, action: () => clicked++ });
    assert.equal(registry.dispatch({ x: 3, y: 8, button: "left" }), true);
    assert.equal(clicked, 2);
});

test("active modal routes clicks only to its own registered controls", () => {
    const registry = new ClickableRegionRegistry();
    let contentClicks = 0;
    let modalClicks = 0;
    registry.register({ id: "settings", x: 0, y: 0, width: 10, height: 1, action: () => contentClicks++ });
    registry.register({ id: "modal-confirm", x: 0, y: 0, width: 10, height: 1, modal: true, action: () => modalClicks++ });
    registry.setModalActive(true);
    assert.equal(registry.dispatch({ x: 1, y: 0, button: "left" }), true);
    assert.equal(contentClicks, 0);
    assert.equal(modalClicks, 1);
    registry.setModalActive(false);
    registry.clear();
    assert.equal(registry.dispatch({ x: 1, y: 0, button: "left" }), false);
});

test("settings select and text editors create safe patches without touching a real env", () => {
    const config: PublicConfig = {
        aiProvider: "gpt",
        gpt: { model: "gpt-6-sol", reasoningEffort: "high", verbosity: "high", configured: false },
        deepseek: { model: "deepseek-flash", reasoningEffort: "high", configured: false },
        logLevel: "info",
        botLoopGuard: { maxCycles: 4, automatedPeerCount: 2 },
    };
    const provider = openConfigModal("aiProvider", config);
    assert.equal(provider.type, "config-select");
    if (provider.type === "config-select") {
        assert.deepEqual(provider.options.map((option) => option.value), ["gpt", "deepseek"]);
        assert.equal(provider.index, 0);
    }
    const text = openConfigModal("gpt.model", config);
    assert.equal(text.type, "config-text");
    assert.equal(textPatch("gpt.model", "gpt-next").value?.field, "gpt.model");
    assert.match(textPatch("botLoopGuard.maxCycles", "0").error ?? "", /大于等于/);
    assert.equal(initialTuiState.modal.type, "none");
});

test("settings shows a pending restart when saved config differs from the running runtime", () => {
    const status: RuntimeStatus = {
        qq: "connected",
        provider: { id: "gpt", model: "gpt-6-sol", webSearch: true, configured: true, reasoningEffort: "high", verbosity: "high" },
        activeCycles: 0,
        contextConversations: 0,
        runtimeConfig: { logLevel: "info", botLoopGuardMaxCycles: 4 },
        memes: { count: 0, revision: 1, loadedAt: "now" },
        prompt: { provider: "gpt", revision: 1, loadedAt: "now" },
        shuttingDown: false,
    };
    const config: PublicConfig = {
        aiProvider: "deepseek",
        gpt: { model: "gpt-6-sol", reasoningEffort: "high", verbosity: "high", configured: true },
        deepseek: { model: "deepseek-flash", reasoningEffort: "high", configured: true },
        logLevel: "info",
        botLoopGuard: { maxCycles: 4, automatedPeerCount: 0 },
    };
    assert.equal(hasPendingRestart(status, config), true);
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
