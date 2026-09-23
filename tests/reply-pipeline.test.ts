import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { QQBot } from "@tencent-connect/qqbot-nodejs";

import { parseQqReplyArguments, type AiResult } from "../src/ai/reply-result.js";
import { isConversationActive } from "../src/qq/conversation/engagement.js";
import { rememberKnownMember, renderStructuredMentions } from "../src/qq/conversation/known-members.js";
import {
    buildChatInput,
    getMessageRevision,
    recordIncomingMessageRevision,
} from "../src/qq/conversation/recent-context.js";
import type { NormalizedQqMessage } from "../src/qq/message/normalize-message.js";

// Loading the coordinator constructs the SDK client, but these tests inject an AI stub.
process.env.CODEX_API_KEY = "offline-test";
process.env.CODEX_BASE_URL = "https://example.invalid";
const { AI_TIMEOUT_REPLY, coordinateAiReply, shouldQuoteTrigger } = await import(
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

test("structured mentions resolve only a unique known nickname", () => {
    const trigger = message();
    rememberKnownMember({ ...trigger, author: { member_openid: "openid-1", username: "尘柒" } });
    const unique = renderStructuredMentions(trigger, "你好", ["尘柒"]);
    assert.match(unique.sendText, /<qqbot-at-user id="openid-1" \/>/);
    assert.equal(unique.contextText, "@尘柒 你好");

    rememberKnownMember({ ...trigger, author: { member_openid: "openid-2", username: "尘柒" } });
    const duplicate = renderStructuredMentions(trigger, "你好", ["尘柒"]);
    assert.equal(duplicate.sendText, "@尘柒 你好");
    assert.equal(renderStructuredMentions(trigger, "你好", ["陌生人"]).sendText, "@陌生人 你好");
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
