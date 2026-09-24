import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { QQBot, QQBotInboundMessage } from "@tencent-connect/qqbot-nodejs";

import { parseQqReplyArguments, type AiResult } from "../src/ai/reply-result.js";
import { isConversationActive } from "../src/qq/conversation/engagement.js";
import { MemoryMemberRepository } from "../src/members/memory-repository.js";
import { configureMemberRepository, rememberKnownMember } from "../src/qq/conversation/known-members.js";
import { renderStructuredMentions } from "../src/qq/reply/mentions.js";
import {
    buildChatInput,
    getConversationKey,
    getMessageRevision,
    rememberIncomingMessage,
    recordIncomingMessageRevision,
} from "../src/qq/conversation/recent-context.js";
import { normalizeQqMessage, type NormalizedQqMessage } from "../src/qq/message/normalize-message.js";

configureMemberRepository(new MemoryMemberRepository());

// Loading the coordinator constructs the SDK client, but these tests inject an AI stub.
process.env.CODEX_API_KEY = "offline-test";
process.env.CODEX_BASE_URL = "https://example.invalid";
const { AI_TIMEOUT_REPLY, coordinateAiReply, shouldQuoteTrigger, handleRecalledMessage, cancelPendingRequestByMessageId } = await import(
    "../src/qq/reply/coordinator.js"
);

function message(groupId: string = randomUUID(), authorId: string = randomUUID()): NormalizedQqMessage {
    const id = randomUUID();
    return {
        source: {} as NormalizedQqMessage["source"],
        id,
        kind: "group",
        eventType: "GROUP_AT_MESSAGE_CREATE",
        content: "小尘 ping",
        displayContent: "小尘 ping",
        groupId,
        author: { id: authorId, member_openid: authorId, username: "用户" },
        authorId,
        authorName: "用户",
        authorIsBot: false,
        mentions: [],
        attachments: [],
        replyTarget: { targetId: groupId, msgId: id } as NormalizedQqMessage["replyTarget"],
        timestamp: new Date().toISOString(),
        raw: {},
    };
}

function fakeBot() {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const bot = {
        send: async (...args: unknown[]) => { calls.push({ method: "send", args }); },
        sendMarkdown: async (...args: unknown[]) => { calls.push({ method: "markdown", args }); },
        sendText: async (...args: unknown[]) => { calls.push({ method: "text", args }); },
    } as unknown as QQBot;
    return { bot, calls };
}

function reply(content: string, quote: "auto" | "trigger" | "none" = "auto"): AiResult {
    return { kind: "reply", source: "qq_reply", action: { content, mentions: [], quote } };
}

function request(bot: QQBot, trigger: NormalizedQqMessage) {
    return {
        bot,
        message: trigger,
        aiInput: "ping",
        imageUrls: [],
        isGroup: true,
        allowNoReply: false,
        onWebSearchStart: () => {},
    };
}

test("revision is monotonic and quote none yields to newer group messages", () => {
    const trigger = message();
    assert.equal(recordIncomingMessageRevision(trigger), 1);
    assert.equal(getMessageRevision(trigger), 1);
    assert.equal(recordIncomingMessageRevision(message(trigger.groupId)), 2);
    assert.equal(getMessageRevision(trigger), 2);
    assert.equal(shouldQuoteTrigger("auto", true, 0, true), false);
    assert.equal(shouldQuoteTrigger("trigger", true, 0, true), true);
    assert.equal(shouldQuoteTrigger("none", true, 1, true), true);
    assert.equal(shouldQuoteTrigger("auto", false, 1, true), false);
    assert.equal(shouldQuoteTrigger("trigger", true, 1, false), false);
});

test("qq_reply parser validates semantic fields", () => {
    assert.deepEqual(parseQqReplyArguments('{"content":"你好","mentions":[" 尘柒 "],"quote":"trigger"}'), {
        content: "你好", mentions: ["尘柒"], quote: "trigger",
    });
    assert.equal(parseQqReplyArguments('{"content":"","mentions":[]}'), null);
    assert.equal(parseQqReplyArguments('{"content":"你好","mentions":[42]}'), null);
    assert.equal(parseQqReplyArguments("not json"), null);
});

test("structured mentions resolve only a unique known nickname", async () => {
    const trigger = message();
    await rememberKnownMember({ ...trigger, author: { member_openid: "openid-1", username: "尘柒" } });
    const unique = await renderStructuredMentions(trigger, "你好", ["尘柒"]);
    assert.match(unique.sendText, /<qqbot-at-user id="openid-1" \/>/);
    assert.equal(unique.contextText, "@尘柒 你好");

    await rememberKnownMember({ ...trigger, author: { member_openid: "openid-2", username: "尘柒" } });
    const duplicate = await renderStructuredMentions(trigger, "你好", ["尘柒"]);
    assert.equal(duplicate.sendText, "@尘柒 你好");
    assert.equal((await renderStructuredMentions(trigger, "你好", ["陌生人"])).sendText, "@陌生人 你好");
});

test("fast reply uses ordinary Markdown send", async () => {
    const trigger = message();
    recordIncomingMessageRevision(trigger);
    const { bot, calls } = fakeBot();
    await coordinateAiReply(request(bot, trigger), {
        executeAi: async () => reply("pong"),
        timeoutMs: 10,
    });
    assert.deepEqual(calls.map((call) => call.method), ["markdown"]);
    assert.equal(calls[0].args[1], "pong");
    assert.equal(isConversationActive(trigger), true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls.length, 1);
});

test("a newer group message quotes the original trigger even with quote none", async () => {
    const trigger = message();
    recordIncomingMessageRevision(trigger);
    const { bot, calls } = fakeBot();
    let resolveAi!: (value: AiResult) => void;
    const ai = new Promise<AiResult>((resolve) => { resolveAi = resolve; });
    const pending = coordinateAiReply(request(bot, trigger), { executeAi: async () => ai });
    recordIncomingMessageRevision(message(trigger.groupId));
    resolveAi(reply("pong", "none"));
    await pending;
    assert.deepEqual(calls.map((call) => call.method), ["send"]);
    assert.deepEqual((calls[0].args[0] as { messageReference: unknown }).messageReference, {
        message_id: trigger.id,
    });
});

test("timeout records local notice, leaves engagement inactive, and discards late AI result", async () => {
    const trigger = message();
    recordIncomingMessageRevision(trigger);
    const { bot, calls } = fakeBot();
    let resolveAi!: (value: AiResult) => void;
    const ai = new Promise<AiResult>((resolve) => { resolveAi = resolve; });
    let signal!: AbortSignal;
    const pending = coordinateAiReply(request(bot, trigger), {
        executeAi: async (_input, options) => {
            signal = options.signal;
            return ai;
        },
        timeoutMs: 10,
    });
    recordIncomingMessageRevision(message(trigger.groupId));
    await pending;
    assert.equal(signal.aborted, true);
    assert.deepEqual(calls.map((call) => call.method), ["send"]);
    const payload = calls[0].args[0] as { markdown: { content: string }; messageReference: { message_id: string } };
    assert.equal(payload.markdown.content, AI_TIMEOUT_REPLY);
    assert.equal(payload.messageReference.message_id, trigger.id);
    assert.match(buildChatInput(trigger, "next"), new RegExp(AI_TIMEOUT_REPLY));
    assert.equal(isConversationActive(trigger), false);

    resolveAi(reply("too late"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls.length, 1);
});

test("NO_REPLY sends nothing and exits group engagement", async () => {
    const trigger = message();
    recordIncomingMessageRevision(trigger);
    const { bot, calls } = fakeBot();
    await coordinateAiReply(request(bot, trigger), { executeAi: async () => ({ kind: "no_reply" }) });
    assert.equal(calls.length, 0);
    assert.equal(isConversationActive(trigger), false);
});

test("incoming QQ IDs become readable mentions in AI input and recent context", async () => {
    const groupId = randomUUID();
    const mentionedId = "member-zhiv";
    const rawMentions = [{ member_openid: mentionedId, username: "芷", bot: false }];
    const source = {
        kind: "group",
        rawEventType: "GROUP_MESSAGE_CREATE",
        content: "<@" + mentionedId + "> 这是谁",
        messageId: randomUUID(),
        groupOpenid: groupId,
        senderId: "author-1",
        senderName: "尘柒喵",
        replyTarget: { scope: "group", targetId: groupId, msgId: "trigger-1" },
        timestamp: new Date().toISOString(),
        mentions: rawMentions,
        raw: {
            group_openid: groupId,
            author: { member_openid: "author-1", username: "尘柒喵" },
            mentions: rawMentions,
        },
    } as unknown as QQBotInboundMessage;
    const normalized = await normalizeQqMessage({}, source);
    assert.equal(normalized.displayContent, "@芷 这是谁");
    await rememberKnownMember(normalized);
    rememberIncomingMessage(normalized, normalized.displayContent);

    const later = { ...source, content: "<@" + mentionedId + "> 好", mentions: [], messageId: randomUUID() };
    assert.equal((await normalizeQqMessage({}, later)).displayContent, "@芷 好");
    assert.equal((await normalizeQqMessage({}, {
        ...later, content: "<@unknown-id> 好",
    })).displayContent, "@未知成员 好");
    const followUp = message(groupId);
    const aiInput = buildChatInput(followUp, "小尘，他是谁");
    assert.match(aiInput, /尘柒喵：@芷 这是谁/);
    assert.doesNotMatch(aiInput, /member-zhiv/);
});

test("recall cancels the matching request, removes context, and beats timeout", async () => {
    const trigger = message();
    recordIncomingMessageRevision(trigger);
    rememberIncomingMessage(trigger, trigger.content);
    const { bot, calls } = fakeBot();
    let resolveAi!: (value: AiResult) => void;
    let signal!: AbortSignal;
    const ai = new Promise<AiResult>((resolve) => { resolveAi = resolve; });
    const pending = coordinateAiReply(request(bot, trigger), {
        executeAi: async (_input, options) => {
            signal = options.signal;
            return ai;
        },
        timeoutMs: 30,
    });
    await Promise.resolve();
    handleRecalledMessage(getConversationKey(trigger), trigger.id!);
    handleRecalledMessage(getConversationKey(trigger), trigger.id!);
    assert.equal(cancelPendingRequestByMessageId(trigger.id!), 0);
    await pending;
    assert.equal(signal.aborted, true);
    assert.equal(calls.length, 0);
    assert.doesNotMatch(buildChatInput(trigger, "next"), /小尘 ping/);
    resolveAi(reply("too late"));
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(calls.length, 0);
});

test("one recalled trigger cancels every matching pending request", async () => {
    const trigger = message();
    recordIncomingMessageRevision(trigger);
    const { bot, calls } = fakeBot();
    const never = new Promise<AiResult>(() => {});
    const first = coordinateAiReply(request(bot, trigger), {
        executeAi: async () => never,
        timeoutMs: 100,
    });
    const second = coordinateAiReply(request(bot, trigger), {
        executeAi: async () => never,
        timeoutMs: 100,
    });
    await Promise.resolve();
    assert.equal(cancelPendingRequestByMessageId(trigger.id!), 2);
    await Promise.all([first, second]);
    assert.equal(calls.length, 0);
});
