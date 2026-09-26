import assert from "node:assert/strict";
import test from "node:test";
import type { TenBotControl, ReloadResult } from "../src/control/tenbot-control.js";
import type { RuntimeStatus } from "../src/control/runtime-status.js";
import type { PublicConfig } from "../src/config/config-types.js";
import { handleTuiKey } from "../src/tui/key-handler.js";
import { createProviderErrorNotice } from "../src/control/provider-error.js";
import type { ProviderErrorNotice } from "../src/control/provider-error.js";
import { TenBotError } from "../src/errors/tenbot-error.js";
import { logger, subscribeLogs } from "../src/shared/logger.js";
import { connectionLabel, formatTuiLogText, reasoningLabel, verbosityLabel } from "../src/tui/i18n.js";
import { closeModal, hasPendingRestart, openConfigModal, readKnownMembers, receiveProviderError, textPatch } from "../src/tui/app.js";
import { activateSidebarPage, clampLogOffset, handleLogsNavigation, initialTuiState, moveSettingsSelection, moveSidebarSelection, quitConfirmationAction, requestQuitConfirmation, toggleTuiFocus } from "../src/tui/state.js";
import { settingsRows } from "../src/tui/state.js";
import { SettingsView } from "../src/tui/views/settings-view.js";
import { supportsInteractiveTui } from "../src/tui/terminal-check.js";
import { ClickableRegionRegistry, SgrMouseParser, TerminalMouseSession } from "../src/tui/mouse-input.js";
import { splitDisplayPath } from "../src/tui/path-display.js";
import { collapseAdjacentLogs } from "../src/tui/log-collapse.js";
import { cycleModelProvider } from "../src/ai/model-registry.js";
import { exitTuiProcess } from "../src/tui/process-exit.js";
import { calculateBubbleWidth, layoutConversationViewport, measureConversationItem, moveConversationAnchor, wrapTerminalText, type ConversationScrollAnchor } from "../src/tui/conversation-layout.js";
import { calculateCenteredModalBounds } from "../src/tui/modal-layout.js";
import { layoutProviderErrorDetails, moveProviderErrorDetailsScroll, providerErrorSummaryPreview } from "../src/tui/provider-error-layout.js";
import { calculateAutomatedPeersLayout } from "../src/tui/automated-peers-layout.js";
import type { ConversationItem } from "../src/control/conversation-timeline.js";

function conversationFixture(count: number, content = "short") : ConversationItem[] {
    return Array.from({ length: count }, (_, index): ConversationItem => index % 2 === 0
        ? { id: `message-${index}`, type: "peer-message", displayName: "尘柒喵", content: `${content} ${index}`, timestamp: "2026-09-26T00:23:46.000Z" }
        : { id: `message-${index}`, type: "ai-reply", content: `${content} ${index}`, timestamp: "2026-09-26T00:23:46.000Z", sendStatus: "sent" });
}

function collectReactElementProps(node: unknown, output: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
    if (Array.isArray(node)) {
        for (const child of node) collectReactElementProps(child, output);
    } else if (node !== null && typeof node === "object" && "props" in node) {
        const props = (node as { props: Record<string, unknown> }).props;
        output.push(props);
        collectReactElementProps(props.children, output);
    }
    return output;
}

function collectReactText(node: unknown): string[] {
    if (typeof node === "string" || typeof node === "number") return [String(node)];
    if (Array.isArray(node)) return node.flatMap(collectReactText);
    if (node !== null && typeof node === "object" && "props" in node) {
        return collectReactText((node as { props: { children?: unknown } }).props.children);
    }
    return [];
}

test("conversation rows wrap ASCII, Chinese, full-width, emoji, and combining graphemes by terminal width", () => {
    assert.deepEqual(wrapTerminalText("abcdef", 4), ["abcd", "ef"]);
    assert.deepEqual(wrapTerminalText("中文测试", 4), ["中文", "测试"]);
    assert.deepEqual(wrapTerminalText("A中B", 3), ["A中", "B"]);
    assert.deepEqual(wrapTerminalText("A🙂BC", 3), ["A🙂", "BC"]);
    assert.deepEqual(wrapTerminalText("e\u0301ab", 2), ["e\u0301a", "b"]);
    assert.deepEqual(wrapTerminalText("first\r\nsecond", 20), ["first", "second"]);
});

test("conversation layout budgets visual rows for variable-height messages", () => {
    const items: ConversationItem[] = [
        { id: "short-a", type: "peer-message", displayName: "尘柒喵", content: "A", timestamp: "2026-09-26T00:23:46.000Z" },
        { id: "short-b", type: "ai-reply", content: "B", timestamp: "2026-09-26T00:23:47.000Z", sendStatus: "sent" },
        { id: "long-c", type: "peer-message", displayName: "尘柒喵", content: "中文测试内容很长消息", timestamp: "2026-09-26T00:23:48.000Z" },
        { id: "short-d", type: "ai-reply", content: "D", timestamp: "2026-09-26T00:23:49.000Z", sendStatus: "sent" },
    ];
    const rowsForLong = measureConversationItem(items[2]!, 8);
    assert.equal(rowsForLong.length, 8, "header + border rows + five wrapped Chinese lines");
    const layout = layoutConversationViewport(items, 8, 12);
    assert.equal(layout.totalRows, 20);
    assert.equal(layout.visibleRows.length, 12);
    assert.ok(layout.visibleRows.length <= 12);
});

test("conversation Up and Down move one visual row and page, Home, and End clamp by rows", () => {
    const items = conversationFixture(10, "中文消息");
    const viewportRows = 20;
    let anchor: ConversationScrollAnchor | null = null;
    anchor = moveConversationAnchor(items, 14, viewportRows, anchor, "up");
    assert.equal(layoutConversationViewport(items, 14, viewportRows, anchor).scrollRowsFromBottom, 1);
    anchor = moveConversationAnchor(items, 14, viewportRows, anchor, "up");
    assert.equal(layoutConversationViewport(items, 14, viewportRows, anchor).scrollRowsFromBottom, 2);
    anchor = moveConversationAnchor(items, 14, viewportRows, anchor, "down");
    assert.equal(layoutConversationViewport(items, 14, viewportRows, anchor).scrollRowsFromBottom, 1);
    anchor = moveConversationAnchor(items, 14, viewportRows, anchor, "down");
    assert.equal(layoutConversationViewport(items, 14, viewportRows, anchor).scrollRowsFromBottom, 0);
    anchor = moveConversationAnchor(items, 14, viewportRows, anchor, "down");
    assert.equal(layoutConversationViewport(items, 14, viewportRows, anchor).scrollRowsFromBottom, 0);
    anchor = moveConversationAnchor(items, 14, viewportRows, anchor, "page-up");
    assert.equal(layoutConversationViewport(items, 14, viewportRows, anchor).scrollRowsFromBottom, 20);
    anchor = moveConversationAnchor(items, 14, viewportRows, anchor, "page-down");
    assert.equal(layoutConversationViewport(items, 14, viewportRows, anchor).scrollRowsFromBottom, 0);
    anchor = moveConversationAnchor(items, 14, viewportRows, anchor, "home");
    assert.equal(layoutConversationViewport(items, 14, viewportRows, anchor).startRow, 0);
    anchor = moveConversationAnchor(items, 14, viewportRows, anchor, "end");
    assert.equal(anchor, null);
    assert.equal(layoutConversationViewport(items, 14, viewportRows, anchor).scrollRowsFromBottom, 0);
});

test("conversation historical anchor stays on the same item through append and resize", () => {
    const items = conversationFixture(10, "history");
    const anchor = moveConversationAnchor(items, 16, 10, null, "page-up");
    assert.ok(anchor);
    const before = layoutConversationViewport(items, 16, 10, anchor).visibleRows[0];
    const appended = [...items, { id: "newest", type: "ai-reply" as const, content: "new message", timestamp: "2026-09-26T00:24:00.000Z", sendStatus: "sent" as const }];
    const afterAppend = layoutConversationViewport(appended, 16, 10, anchor).visibleRows[0];
    assert.deepEqual([afterAppend?.itemId, afterAppend?.rowOffset], [before?.itemId, before?.rowOffset]);
    const afterResize = layoutConversationViewport(appended, 12, 10, anchor).visibleRows[0];
    assert.equal(afterResize?.itemId, before?.itemId);
    assert.ok(layoutConversationViewport(appended, 12, 10, anchor).visibleRows.length <= 10);
});

test("conversation at the bottom follows newly appended messages", () => {
    const items = conversationFixture(3);
    const before = layoutConversationViewport(items, 16, 8, null);
    const appended = [...items, { id: "latest", type: "ai-reply" as const, content: "latest reply", timestamp: "2026-09-26T00:24:00.000Z", sendStatus: "sent" as const }];
    const after = layoutConversationViewport(appended, 16, 8, null);
    assert.equal(before.scrollRowsFromBottom, 0);
    assert.equal(after.scrollRowsFromBottom, 0);
    assert.equal(after.visibleRows.at(-1)?.itemId, "latest");
});

test("attempt status cards retain a fixed visual footprint and omit successful completion", () => {
    const generating: ConversationItem = { id: "attempt", type: "ai-attempt", cycleId: "cycle", attemptId: "attempt", timestamp: "2026-09-26T00:23:46.000Z", status: "generating" };
    const interrupted = { ...generating, status: "interrupted" as const };
    const generationFailed = { ...generating, status: "failed" as const, failureStage: "generation" as const };
    const sendFailed = { ...generating, status: "failed" as const, failureStage: "send" as const };
    assert.equal(measureConversationItem(generating, 20).length, measureConversationItem(interrupted, 20).length);
    assert.ok(measureConversationItem(generating, 20).some((row) => row.text.includes("生成中")));
    assert.ok(measureConversationItem(interrupted, 20).some((row) => row.text.includes("被中断")));
    assert.ok(measureConversationItem(generationFailed, 20).some((row) => row.text.includes("生成失败")));
    const sendFailureRows = measureConversationItem(sendFailed, 20)
        .filter((row) => row.text.startsWith("│ "))
        .map((row) => row.text.slice(2).replace(/ │$/, "").trimEnd())
        .join("");
    assert.match(sendFailureRows, /生成完成，发送失败/);
    assert.deepEqual(measureConversationItem({ ...generating, status: "completed" }, 20), []);
});

test("a message taller than the viewport can be read a visual row at a time", () => {
    const long: ConversationItem = {
        id: "very-long",
        type: "peer-message",
        displayName: "尘柒喵",
        content: "中文内容🙂".repeat(40),
        timestamp: "2026-09-26T00:23:46.000Z",
    };
    const viewportRows = 5;
    const bubbleWidth = 12;
    const expectedContentRows = wrapTerminalText(long.content, bubbleWidth - 4).length;
    assert.ok(measureConversationItem(long, bubbleWidth).length > viewportRows);
    const seenContentRows = new Set<number>();
    let anchor = moveConversationAnchor([long], bubbleWidth, viewportRows, null, "home");
    for (let index = 0; index < measureConversationItem(long, bubbleWidth).length + 2 && anchor; index++) {
        const layout = layoutConversationViewport([long], bubbleWidth, viewportRows, anchor);
        assert.ok(layout.visibleRows.length <= viewportRows);
        for (const row of layout.visibleRows) {
            if (row.tone === "peer" && row.rowOffset >= 2 && row.rowOffset < expectedContentRows + 2) seenContentRows.add(row.rowOffset - 2);
        }
        const next = moveConversationAnchor([long], bubbleWidth, viewportRows, anchor, "down");
        if (next?.itemId === anchor?.itemId && next.rowOffset === anchor?.rowOffset) break;
        anchor = next;
    }
    assert.equal(seenContentRows.size, expectedContentRows);
});

test("bubble width uses the measured viewport width and tracks a terminal resize", () => {
    assert.equal(calculateBubbleWidth(100), 78);
    assert.equal(calculateBubbleWidth(60), 46);
    assert.ok(measureConversationItem(conversationFixture(1)[0]!, calculateBubbleWidth(60)).every((row) => row.text.length <= 46));
});

test("modal bounds stay centered and clamp width and height after resize", () => {
    assert.deepEqual(calculateCenteredModalBounds(120, 40, 60, 10), { left: 30, top: 15, width: 60, height: 10 });
    assert.deepEqual(calculateCenteredModalBounds(90, 30, 80, 40), { left: 5, top: 1, width: 80, height: 28 });
    assert.deepEqual(calculateCenteredModalBounds(60, 8, 72, 12), { left: 2, top: 1, width: 56, height: 6 });
});

function fakeControl(calls: string[], result: ReloadResult = { ok: true, message: "reloaded", loadedAt: "now" }): TenBotControl {
    const status: RuntimeStatus = {
        qq: "disconnected", provider: { id: "gpt", model: "test", webSearch: true, configured: false },
        activeCycles: 0, contextConversations: 0,
        memes: { count: 0, revision: 1, loadedAt: "now" },
        prompt: { provider: "gpt", revision: 1, loadedAt: "now" }, shuttingDown: false,
    };
    const config: PublicConfig = {
        aiProvider: "gpt",
        replyJudge: { model: "judge-test", timeoutMs: 5_000 },
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
        getKnownMembers: async () => [],
        getConversations: () => [],
        getConversationTimeline: () => [],
        async addAutomatedPeer() { return { ok: true, changed: true, message: "added" }; },
        async removeAutomatedPeer() { return { ok: true, changed: true, message: "removed" }; },
        subscribeStatus: () => () => undefined,
        subscribeLogs: () => () => undefined,
        subscribeEvents: () => () => undefined,
        async reloadPrompt() { calls.push("prompt"); return result; },
        async reloadReplyJudgePrompt() { return result; },
        async reloadMemes() { calls.push("memes"); return result; },
        async getEditorResource() { throw new Error("unused"); },
        async saveEditorResource() { throw new Error("unused"); },
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

test("Prompt path display handles Windows and POSIX paths", () => {
    assert.deepEqual(splitDisplayPath("C:\\TenBot\\src\\ai\\plugins\\gpt\\prompt.md"), {
        fileName: "prompt.md", directory: "C:/TenBot/src/ai/plugins/gpt",
    });
    assert.deepEqual(splitDisplayPath("src/ai/plugins/deepseek/prompt.md"), {
        fileName: "prompt.md", directory: "src/ai/plugins/deepseek",
    });
});

test("TUI log folding merges only adjacent same-level display rows and keeps the latest timestamp", () => {
    const rows = collapseAdjacentLogs([
        { timestamp: "t1", level: "debug", text: "A" },
        { timestamp: "t2", level: "debug", text: "A" },
        { timestamp: "t3", level: "debug", text: "A" },
        { timestamp: "t4", level: "info", text: "B" },
        { timestamp: "t5", level: "debug", text: "A" },
    ]);
    assert.deepEqual(rows.map(({ displayText, count, entry }) => [displayText, count, entry.timestamp]), [
        ["A", 3, "t3"], ["B", 1, "t4"], ["A", 1, "t5"],
    ]);
});

test("provider carousel cycles its view without changing the selected runtime configuration", () => {
    assert.equal(cycleModelProvider("gpt", 1), "deepseek");
    assert.equal(cycleModelProvider("deepseek", 1), "gpt");
    assert.equal(cycleModelProvider("gpt", -1), "deepseek");
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

test("centered modal click regions follow the resized center and ignore old corner coordinates", () => {
    const registry = new ClickableRegionRegistry();
    let clicked = 0;
    const bounds = calculateCenteredModalBounds(90, 30, 60, 10);
    registry.register({ id: "modal:confirm", x: bounds.left + 10, y: bounds.top + 8, width: 12, height: 1, modal: true, action: () => clicked++ });
    registry.setModalActive(true);
    assert.equal(registry.dispatch({ x: bounds.left + 11, y: bounds.top + 8, button: "left" }), true);
    assert.equal(registry.dispatch({ x: 3, y: 3, button: "left" }), false);
    const resized = calculateCenteredModalBounds(120, 40, 60, 10);
    registry.clear();
    registry.register({ id: "modal:confirm", x: resized.left + 10, y: resized.top + 8, width: 12, height: 1, modal: true, action: () => clicked++ });
    assert.equal(registry.dispatch({ x: resized.left + 11, y: resized.top + 8, button: "left" }), true);
    assert.equal(clicked, 2);
});

test("settings select and text editors create safe patches without touching a real env", () => {
    const config: PublicConfig = {
        aiProvider: "gpt",
        replyJudge: { model: "Qwen/Qwen3.5-4B", timeoutMs: 5_000 },
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
    const judgeModel = openConfigModal("replyJudge.model", config);
    assert.equal(judgeModel.type, "config-text");
    if (judgeModel.type === "config-text") assert.equal(judgeModel.value, "Qwen/Qwen3.5-4B");
    const judgeTimeout = openConfigModal("replyJudge.timeoutMs", config);
    assert.equal(judgeTimeout.type, "config-text");
    if (judgeTimeout.type === "config-text") assert.equal(judgeTimeout.value, "5000");
    assert.deepEqual(textPatch("replyJudge.model", "THUDM/GLM-4-9B-0414").value, { field: "replyJudge.model", value: "THUDM/GLM-4-9B-0414" });
    assert.deepEqual(textPatch("replyJudge.timeoutMs", "15000").value, { field: "replyJudge.timeoutMs", value: 15_000 });
    assert.match(textPatch("replyJudge.timeoutMs", "999").error ?? "", /1000 到 30000/);
    assert.match(textPatch("replyJudge.timeoutMs", "1500.5").error ?? "", /1000 到 30000/);
    assert.match(textPatch("botLoopGuard.maxCycles", "0").error ?? "", /大于等于/);
    assert.equal(initialTuiState.modal.type, "none");
});

test("settings render Reply Judge as an equal-width settings column with keyboard and mouse rows", () => {
    const config: PublicConfig = {
        aiProvider: "gpt",
        replyJudge: { model: "Qwen/Qwen3.5-4B", timeoutMs: 15_000 },
        gpt: { model: "gpt-6-sol", reasoningEffort: "high", verbosity: "high", configured: true },
        deepseek: { model: "deepseek-flash", reasoningEffort: "high", configured: true },
        logLevel: "info",
        botLoopGuard: { maxCycles: 4, automatedPeerCount: 2 },
    };
    const status: RuntimeStatus = {
        qq: "connected",
        provider: { id: "gpt", model: "gpt-6-sol", webSearch: true, configured: true },
        activeCycles: 0,
        contextConversations: 0,
        runtimeConfig: { logLevel: "info", botLoopGuardMaxCycles: 4 },
        hotReload: { enabled: true, revision: 3, loadedAt: "now", lastSuccessAt: "now", requiresRestart: false },
        memes: { count: 0, revision: 1, loadedAt: "now" },
        prompt: { provider: "gpt", revision: 1, loadedAt: "now" },
        shuttingDown: false,
    };
    const edited: string[] = [];
    const tree = SettingsView({
        status, config, selectedIndex: 7, pendingRestart: false, viewedProvider: "gpt", width: 100,
        registry: new ClickableRegionRegistry(), onEdit: (field) => edited.push(field), onViewProvider() {}, onApplyProvider() {},
    });
    const props = collectReactElementProps(tree);
    const text = collectReactText(tree).join(" ");

    assert.equal(props.some((item) => item.title === "回复判断"), true);
    assert.match(text, /Qwen\/Qwen3\.5-4B/);
    assert.match(text, /15000 ms/);
    assert.doesNotMatch(text, /API_KEY|BASE_URL|openai-compatible|FRONT_MODE/);

    const outerRow = props.find((item) => item.flexDirection === "row" && item.width === "100%" && item.flexGrow === 1);
    assert.ok(outerRow);
    const columns = outerRow.children as Array<{ props: Record<string, unknown> }>;
    assert.equal(columns.length, 2);
    assert.ok(columns.every((column) => column.props.flexGrow === 1 && column.props.flexBasis === 0));

    const clickTargets = props.filter((item) => item.id === "settings:replyJudge.model" || item.id === "settings:replyJudge.timeoutMs");
    assert.deepEqual(clickTargets.map((item) => item.id), ["settings:replyJudge.model", "settings:replyJudge.timeoutMs"]);
    for (const target of clickTargets) (target.onClick as () => void)();
    assert.deepEqual(edited, ["replyJudge.model", "replyJudge.timeoutMs"]);

    const rows = settingsRows("gpt");
    const modelIndex = rows.indexOf("replyJudge.model");
    const timeoutIndex = rows.indexOf("replyJudge.timeoutMs");
    assert.equal(rows[modelIndex], "replyJudge.model");
    assert.equal(rows[timeoutIndex], "replyJudge.timeoutMs");
    assert.equal(moveSettingsSelection(modelIndex - 1, 1, rows.length), modelIndex);
    assert.equal(moveSettingsSelection(timeoutIndex - 1, 1, rows.length), timeoutIndex);
    assert.deepEqual(rows.slice(-2), ["replyJudge.model", "replyJudge.timeoutMs"]);
    const narrowTree = SettingsView({
        status, config, selectedIndex: 0, pendingRestart: false, viewedProvider: "gpt", width: 70,
        registry: new ClickableRegionRegistry(), onEdit() {}, onViewProvider() {}, onApplyProvider() {},
    });
    assert.equal(collectReactElementProps(narrowTree).some((item) => item.flexDirection === "column" && item.width === "100%" && item.flexGrow === 1), true);
});

test("settings shows pending restart only when Runtime marks a non-hot-reloadable change", () => {
    const status: RuntimeStatus = {
        qq: "connected",
        provider: { id: "gpt", model: "gpt-6-sol", webSearch: true, configured: true, reasoningEffort: "high", verbosity: "high" },
        activeCycles: 0,
        contextConversations: 0,
        runtimeConfig: { logLevel: "info", botLoopGuardMaxCycles: 4 },
        hotReload: { enabled: true, revision: 2, loadedAt: "now", lastSuccessAt: "now", requiresRestart: true },
        memes: { count: 0, revision: 1, loadedAt: "now" },
        prompt: { provider: "gpt", revision: 1, loadedAt: "now" },
        shuttingDown: false,
    };
    const config: PublicConfig = {
        aiProvider: "deepseek",
        replyJudge: { model: "judge-test", timeoutMs: 5_000 },
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
    assert.deepEqual({ provider: notice.provider, model: notice.model, tenbotCode: notice.tenbotCode, status: notice.status, code: notice.code, retryable: notice.retryable }, {
        provider: "gpt", model: "gpt-6-sol", tenbotCode: "R:A_MP_PSU", status: 503, code: "service_unavailable", retryable: true,
    });
    assert.doesNotMatch(JSON.stringify(notice), /super-secret|sk-live-secret|authorization|api[_ -]?key|cookie/i);
    assert.match(notice.message, /redacted|失败|service/i);
});

test("Provider Error details wrap complete sanitized text, clamp row scrolling, and preserve actions", () => {
    const longMessage = `safe https://api-user:api-pass@example.test/path ${"中文 mixed text 🙂 ".repeat(80)} tail-marker`;
    const longDetails = `detail ${"ASCII 界🙂 ".repeat(90)} details-tail`;
    const notice = createProviderErrorNotice("gpt", "gpt-6-sol", Object.assign(
        new Error(longMessage), { status: 503, cause: new Error(`${longDetails} api_key=secret-value`),
        authorization: "Bearer secret-value" },
    ));
    assert.equal(notice.message.includes("tail-marker"), true);
    assert.doesNotMatch(JSON.stringify(notice), /secret-value|api-user|api-pass/);
    assert.match(notice.details ?? "", /details-tail/);

    const normal = layoutProviderErrorDetails(notice, 72, 22, 1, 0);
    assert.equal(normal.compact, false);
    assert.equal(normal.showActions, true);
    assert.ok(normal.visibleLines.length <= normal.viewportRows);
    assert.ok(normal.maxScrollOffset > 0);
    assert.ok(normal.contentLines.join("\n").includes("tail-marker"));
    assert.ok(normal.contentLines.join("\n").includes("details-tail"));

    const low = layoutProviderErrorDetails(notice, 68, 12, 1, 0);
    assert.equal(low.compact, true);
    assert.equal(low.showActions, true);
    assert.ok(low.viewportRows >= 1);
    assert.ok(low.metadataLines.length <= 2);

    const offset = (key: "up" | "down" | "page-up" | "page-down" | "home" | "end", current = 0) =>
        moveProviderErrorDetailsScroll(notice, 1, 80, 24, current, key);
    assert.equal(offset("up"), 0);
    assert.equal(offset("down"), 1);
    assert.ok(offset("page-down") > 1);
    assert.equal(offset("home", 3), 0);
    assert.equal(offset("end"), normal.maxScrollOffset);
    assert.equal(offset("page-up", normal.maxScrollOffset), Math.max(0, normal.maxScrollOffset - normal.viewportRows));
    assert.equal(offset("down", normal.maxScrollOffset), normal.maxScrollOffset);

    const summary = providerErrorSummaryPreview(notice, 72, 22, 1);
    assert.equal(summary.hasMore, true);
    assert.ok(summary.lines.length > 0);
});

test("known-member page switches between stacked and two-column layouts", () => {
    const narrow = calculateAutomatedPeersLayout(58, 8);
    assert.equal(narrow.mode, "stacked");
    assert.ok(narrow.leftRows < 8);
    const medium = calculateAutomatedPeersLayout(88, 8);
    assert.equal(medium.mode, "stacked");
    const wide = calculateAutomatedPeersLayout(96, 8);
    assert.equal(wide.mode, "columns");
    assert.equal(wide.leftWidth + wide.rightWidth, 96);
    assert.deepEqual(calculateAutomatedPeersLayout(96, 8).mode, "columns");
});

test("TUI known-member read degrades to an empty list on repository failure", async () => {
    const failedControl = { async getKnownMembers() { throw new Error("database unavailable"); } } as unknown as TenBotControl;
    assert.deepEqual(await readKnownMembers(failedControl), []);
});

test("provider errors open one modal and queue subsequent errors", () => {
    const first = { provider: "gpt", model: "gpt-6-sol", tenbotCode: "M:A_MG_MRF" as const, message: "暂时不可用", timestamp: "now" };
    const second = { provider: "gpt", model: "gpt-6-sol", tenbotCode: "M:A_MG_MRF" as const, message: "再次失败", timestamp: "later" };
    const opened = receiveProviderError(initialTuiState, first);
    assert.equal(opened.modal.type, "provider-error");
    const queued = receiveProviderError({ ...opened, modal: { type: "help" } }, second);
    assert.equal(queued.queuedProviderError?.notice.message, "再次失败");
    const next = closeModal(queued);
    assert.equal(next.modal.type, "provider-error");
    if (next.modal.type === "provider-error") assert.equal(next.modal.notice.message, "再次失败");
});

test("Provider Error modal is selected by parsed error class", () => {
    const notice = (tenbotCode: ProviderErrorNotice["tenbotCode"]) => ({
        provider: "gpt",
        model: "gpt-6-sol",
        tenbotCode,
        message: "safe error",
        timestamp: "now",
    });

    const classA = receiveProviderError(initialTuiState, notice("R:A_MP_PSU"));
    assert.equal(classA.modal.type, "provider-error");
    if (classA.modal.type === "provider-error") assert.equal(classA.modal.notice.tenbotCode, "R:A_MP_PSU");

    const classB = receiveProviderError(initialTuiState, notice("B:B_QT_PSF"));
    assert.equal(classB.modal.type, "provider-error");

    const classC = receiveProviderError(initialTuiState, notice("M:C_NS_NRL"));
    assert.equal(classC, initialTuiState);

    const unknownNotice = notice("not-a-tenbot-code" as ProviderErrorNotice["tenbotCode"]);
    const unknown = receiveProviderError(initialTuiState, unknownNotice);
    assert.equal(unknown.modal.type, "provider-error");
});

test("class C remains logged while its Provider Error notification stays UI-silent", () => {
    const entries: string[] = [];
    const unsubscribe = subscribeLogs((entry) => entries.push(entry.text));
    const previousConsoleError = console.error;
    console.error = () => undefined;
    try {
        const error = new TenBotError("M:C_NS_NRL");
        logger.error(error);
        const notice = createProviderErrorNotice("search", "search-model", error);
        assert.equal(receiveProviderError(initialTuiState, notice), initialTuiState);
        assert.equal(entries.some((entry) => entry.includes("M:C_NS_NRL")), true);
    } finally {
        unsubscribe();
        console.error = previousConsoleError;
    }
});

test("multiple A/B error events reuse one visible Provider Error modal", () => {
    const notice: ProviderErrorNotice = {
        provider: "gpt",
        model: "gpt-6-sol",
        tenbotCode: "R:A_MP_PSU",
        message: "safe error",
        timestamp: "now",
    };
    const opened = receiveProviderError(initialTuiState, notice);
    const repeated = receiveProviderError(opened, notice);
    assert.equal(repeated.modal.type, "provider-error");
    assert.equal(repeated.queuedProviderError, undefined);
    if (repeated.modal.type === "provider-error") assert.equal(repeated.modal.count, 2);
});

test("TUI refuses non-TTY streams before rendering", () => {
    assert.equal(supportsInteractiveTui({ isTTY: true }, { isTTY: true }), true);
    assert.equal(supportsInteractiveTui({ isTTY: false }, { isTTY: true }), false);
    assert.equal(supportsInteractiveTui({ isTTY: true }, { isTTY: false }), false);
});

test("TUI process exits only after terminal cleanup output has flushed", async () => {
    const order: string[] = [];
    await exitTuiProcess({ write(_value, callback) { order.push("write"); callback?.(); } }, (code) => {
        assert.equal(code, 0);
        order.push("exit");
    });
    assert.deepEqual(order, ["write", "exit"]);
});
