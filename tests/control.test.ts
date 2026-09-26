import assert from "node:assert/strict";
import test from "node:test";
import { createTenBotControl } from "../src/control/tenbot-control.js";
import type { RuntimeStatus } from "../src/control/runtime-status.js";
import { LogBuffer } from "../src/control/log-buffer.js";
import { MAX_TUI_LOG_ENTRIES } from "../src/control/tenbot-control.js";
import { getLogLevel, logger, setConsoleLogOutputEnabled, setLogLevel, subscribeLogs } from "../src/shared/logger.js";
import type { PublicConfig } from "../src/config/config-types.js";
import { ConversationTimelineStore, createIncomingConversationEvent } from "../src/control/conversation-timeline.js";
import { toConversationIdentity } from "../src/control/conversation-identity.js";
import { getConversationKey } from "../src/qq/conversation/recent-context.js";
import type { NormalizedQqMessage } from "../src/qq/message/normalize-message.js";

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

test("logger level can change at runtime and affects plain and subscribed logs", () => {
    const previousLevel = getLogLevel();
    const previousConsole = console.error;
    const entries: string[] = [];
    const unsubscribe = subscribeLogs((entry) => entries.push(entry.text));
    console.error = () => undefined;
    try {
        setLogLevel("error");
        logger.info("hidden after hot reload");
        logger.error("visible after hot reload");
        assert.deepEqual(entries, ["visible after hot reload"]);
        assert.equal(logger.level, "error");
    } finally {
        unsubscribe();
        setLogLevel(previousLevel);
        console.error = previousConsole;
    }
});

test("conversation timeline keeps interrupted attempts and bounds per-conversation history", () => {
    const store = new ConversationTimelineStore(2, 3);
    const event = (item: Parameters<ConversationTimelineStore["append"]>[0]["item"]): Parameters<ConversationTimelineStore["append"]>[0] => ({
        type: "conversation-item", conversationId: "c-a", kind: "group", label: "群 A", item,
    });
    store.append(event({ id: "attempt:a1", type: "ai-attempt", cycleId: "cycle-1", attemptId: "a1", timestamp: "1", status: "generating" }));
    store.append(event({ id: "message:1", type: "peer-message", displayName: "成员", content: "消息", timestamp: "2" }));
    store.append(event({ id: "attempt:a1", type: "ai-attempt", cycleId: "cycle-1", attemptId: "a1", timestamp: "3", status: "interrupted" }));
    store.append(event({ id: "attempt:a2", type: "ai-attempt", cycleId: "cycle-1", attemptId: "a2", timestamp: "4", status: "generating" }));
    store.append(event({ id: "attempt:a2", type: "ai-attempt", cycleId: "cycle-1", attemptId: "a2", timestamp: "5", status: "completed" }));
    const items = store.get("c-a");
    assert.equal(items.length, 2);
    assert.equal(items.find((item) => item.type === "ai-attempt" && item.attemptId === "a1")?.type, "ai-attempt");
    assert.equal((items[0] as { status?: string }).status, "interrupted");
    assert.equal(store.list()[0]?.label, "群 A");
});

test("conversation timeline keeps interrupted and failed attempts but coalesces successful completion", () => {
    const store = new ConversationTimelineStore();
    const event = (item: Parameters<ConversationTimelineStore["append"]>[0]["item"]): Parameters<ConversationTimelineStore["append"]>[0] => ({
        type: "conversation-item", conversationId: "c-life", kind: "private", label: "私聊 1234ABCD", item,
    });
    store.append(event({ id: "attempt:interrupted", type: "ai-attempt", cycleId: "c1", attemptId: "interrupted", timestamp: "1", status: "generating" }));
    store.append(event({ id: "attempt:interrupted", type: "ai-attempt", cycleId: "c1", attemptId: "interrupted", timestamp: "2", status: "interrupted" }));
    store.append(event({ id: "attempt:generation-failed", type: "ai-attempt", cycleId: "c2", attemptId: "generation-failed", timestamp: "3", status: "failed", failureStage: "generation" }));
    store.append(event({ id: "attempt:send-failed", type: "ai-attempt", cycleId: "c3", attemptId: "send-failed", timestamp: "4", status: "failed", failureStage: "send" }));
    store.append(event({ id: "attempt:success", type: "ai-attempt", cycleId: "c4", attemptId: "success", timestamp: "5", status: "generating" }));
    store.append(event({ id: "reply:success", type: "ai-reply", content: "真正的回复", timestamp: "6", sendStatus: "sent" }));
    store.append(event({ id: "attempt:success", type: "ai-attempt", cycleId: "c4", attemptId: "success", timestamp: "7", status: "completed" }));
    const items = store.get("c-life");
    assert.deepEqual(items.filter((item) => item.type === "ai-attempt").map((item) => item.type === "ai-attempt" ? [item.status, item.failureStage] : []), [
        ["interrupted", undefined], ["failed", "generation"], ["failed", "send"],
    ]);
    assert.deepEqual(items.map((item) => item.type), ["ai-attempt", "ai-attempt", "ai-attempt", "ai-reply"]);
});

function normalizedMessage(kind: "group" | "c2c" | "dm", options: { groupId?: string; authorId: string; eventType?: string; displayContent?: string }): NormalizedQqMessage {
    return {
        source: {} as NormalizedQqMessage["source"],
        id: "real-qq-message-id",
        kind,
        eventType: options.eventType ?? (kind === "group" ? "GROUP_MESSAGE" : "C2C_MESSAGE_CREATE"),
        content: options.displayContent ?? "小尘",
        displayContent: options.displayContent ?? "小尘",
        ...(options.groupId ? { groupId: options.groupId } : {}),
        author: { member_openid: options.authorId },
        authorId: options.authorId,
        authorName: "尘柒喵",
        authorIsBot: false,
        mentions: [],
        attachments: [],
        replyTarget: undefined as unknown as NormalizedQqMessage["replyTarget"],
        timestamp: "2026-09-26T00:23:46.000Z",
        raw: { member_openid: options.authorId, message_id: "real-qq-message-id" },
    };
}

test("conversation identity distinguishes private and group keys without exposing identifiers", () => {
    const group = toConversationIdentity("group:abc");
    const privateConversation = toConversationIdentity("private:xyz");
    assert.equal(group.kind, "group");
    assert.match(group.label, /^群 [A-F0-9]{8}$/);
    assert.equal(privateConversation.kind, "private");
    assert.match(privateConversation.label, /^私聊 [A-F0-9]{8}$/);
    assert.doesNotMatch(JSON.stringify([group, privateConversation]), /abc|xyz|group:|private:/);
});

test("private peer message and reply lifecycle share the Reply Cycle conversation key", () => {
    const message = normalizedMessage("c2c", { authorId: "member_openid-private-secret" });
    const incoming = createIncomingConversationEvent(message, "peer-sequence-1");
    const replyIdentity = toConversationIdentity(getConversationKey(message));
    const store = new ConversationTimelineStore();
    store.append(incoming);
    store.append({
        type: "conversation-item",
        conversationId: replyIdentity.conversationId,
        kind: replyIdentity.kind,
        label: replyIdentity.label,
        item: { id: "reply-sequence-2", type: "ai-reply", content: "嗯，在的", timestamp: "2026-09-26T00:23:49.000Z", sendStatus: "sent" },
    });
    const summary = store.list()[0];
    const timeline = store.get(replyIdentity.conversationId);
    assert.equal(summary?.kind, "private");
    assert.match(summary?.label ?? "", /^私聊 [A-F0-9]{8}$/);
    assert.deepEqual(timeline.map((item) => item.type), ["peer-message", "ai-reply"]);
    assert.equal(incoming.conversationId, replyIdentity.conversationId);
    assert.doesNotMatch(JSON.stringify({ incoming, summary, timeline }), /member_openid-private-secret|real-qq-message-id|private:/);
});

test("group message and group-at peer events stay in the same conversation as AI replies", () => {
    const first = normalizedMessage("group", { groupId: "sensitive-group-openid", authorId: "member-a", eventType: "GROUP_MESSAGE", displayContent: "普通消息" });
    const at = normalizedMessage("group", { groupId: "sensitive-group-openid", authorId: "member-a", eventType: "GROUP_AT", displayContent: "@小尘 你好" });
    const firstEvent = createIncomingConversationEvent(first, "peer-sequence-1");
    const atEvent = createIncomingConversationEvent(at, "peer-sequence-2");
    const identity = toConversationIdentity(getConversationKey(first));
    const store = new ConversationTimelineStore();
    store.append(firstEvent);
    store.append(atEvent);
    store.append({
        type: "conversation-item",
        conversationId: identity.conversationId,
        kind: identity.kind,
        label: identity.label,
        item: { id: "reply-sequence-3", type: "ai-reply", content: "收到", timestamp: "2026-09-26T00:23:49.000Z", sendStatus: "sent" },
    });
    assert.equal(firstEvent.conversationId, atEvent.conversationId);
    assert.equal(identity.kind, "group");
    assert.deepEqual(store.get(identity.conversationId).map((item) => item.type), ["peer-message", "peer-message", "ai-reply"]);
    assert.doesNotMatch(JSON.stringify(store.list()), /sensitive-group-openid|member-a/);
});
