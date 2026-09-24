import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { QQBot, QQBotInboundMessage } from "@tencent-connect/qqbot-nodejs";

import { normalizeTextReply, type AiResult } from "../src/ai/reply-result.js";
import { normalizeQQReplyAction, parseQqReplyArguments, qqReplyTool } from "../src/skills/qq-reply/skill.js";
import { AiResponseFailure, classifyUpstreamFailure } from "../src/ai/upstream-error.js";
import { isConversationActive } from "../src/qq/conversation/engagement.js";
import { MemoryMemberRepository } from "../src/members/memory-repository.js";
import { configureMemberRepository, rememberKnownMember } from "../src/qq/conversation/known-members.js";
import { renderStructuredMentions } from "../src/qq/reply/mentions.js";
import { logger } from "../src/shared/logger.js";
import {
    buildChatInput,
    getConversationKey,
    getMessageRevision,
    rememberIncomingMessage,
    recordIncomingMessageRevision,
    removeMessageFromContext,
} from "../src/qq/conversation/recent-context.js";
import { normalizeQqMessage, type NormalizedQqMessage } from "../src/qq/message/normalize-message.js";

configureMemberRepository(new MemoryMemberRepository());

// Loading the coordinator constructs the SDK client, but these tests inject an AI stub.
process.env.CODEX_API_KEY = "offline-test";
process.env.CODEX_BASE_URL = "https://example.invalid";
const { AI_TIMEOUT_REPLY, AI_WEB_SEARCH_TIMEOUT_REPLY, AI_UPSTREAM_ERROR_REPLY, MULTI_MESSAGE_DELAY_MS, coordinateAiReply, shouldQuoteTrigger,
    handleRecalledMessage, cancelPendingRequestByMessageId } = await import(
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

function reply(content: string | string[], quote: "auto" | "trigger" | "none" = "auto"): AiResult {
    return { kind: "reply", action: {
        messages: Array.isArray(content) ? content : [content], mentions: [], quote,
    } };
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
        messages: ["你好"], mentions: ["尘柒"], quote: "trigger",
    });
    assert.equal(parseQqReplyArguments('{"content":"","mentions":[]}'), null);
    assert.equal(parseQqReplyArguments('{"content":"你好","mentions":[42]}'), null);
    assert.equal(parseQqReplyArguments("not json"), null);
});

test("plain output_text and code blocks always normalize to one message", () => {
    assert.deepEqual(normalizeTextReply(" hello "), {
        kind: "reply", action: { messages: ["hello"], mentions: [], quote: "auto" },
    });
    const code = "```ts\nconsole.log('a。b');\n```";
    assert.deepEqual(normalizeTextReply(code), {
        kind: "reply", action: { messages: [code], mentions: [], quote: "auto" },
    });
    assert.equal(normalizeTextReply("  "), null);
});

test("qq_reply schema and parser limit clean messages to three", () => {
    assert.equal(MULTI_MESSAGE_DELAY_MS, 450);
    const schema = qqReplyTool.parameters.properties.messages;
    assert.equal(schema.minItems, 1);
    assert.equal(schema.maxItems, 3);
    assert.deepEqual(parseQqReplyArguments(JSON.stringify({
        messages: [" 放心 ", "", " 毕竟我没身体 ", "第三句", "第四句"],
        mentions: [], quote: "auto",
    }))?.messages, ["放心", "毕竟我没身体", "第三句"]);
    assert.equal(parseQqReplyArguments('{"messages":["",42]}'), null);
    assert.equal(parseQqReplyArguments('{"messages":"hello"}'), null);
});

test("QQ Reply Skill keeps only semantic fields", () => {
    assert.deepEqual(Object.keys(qqReplyTool.parameters.properties), ["messages", "mentions", "quote"]);
    assert.deepEqual(normalizeQQReplyAction({
        messages: ["你好"], mentions: ["芷"], quote: "trigger",
        msg_type: 2, msg_id: "raw-id", member_openid: "raw-openid", localPath: "C:\\secret.png",
    }), { messages: ["你好"], mentions: ["芷"], quote: "trigger" });
});

test("plain output and qq_reply use the same renderer and sender", async () => {
    const plain = normalizeTextReply("你好");
    const toolAction = parseQqReplyArguments('{"messages":["你好"],"mentions":[],"quote":"auto"}');
    assert.ok(plain && toolAction);
    for (const result of [plain, { kind: "reply" as const, action: toolAction }]) {
        const trigger = message();
        recordIncomingMessageRevision(trigger);
        const { bot, calls } = fakeBot();
        await coordinateAiReply(request(bot, trigger), { executeAi: async () => result });
        assert.deepEqual(calls, [{ method: "markdown", args: [trigger.replyTarget, "你好"] }]);
    }
});

test("coordinator also caps injected replies and skips empty entries", async () => {
    const trigger = message();
    recordIncomingMessageRevision(trigger);
    const { bot, calls } = fakeBot();
    await coordinateAiReply(request(bot, trigger), {
        executeAi: async () => reply([" 一 ", "", " 二 ", " 三 ", " 四 "]),
        multiMessageDelayMs: 0,
    });
    assert.deepEqual(calls.map((call) => call.args[1]), ["一", "二", "三"]);
});

test("a reply with no valid messages uses one safe error notice", async () => {
    const trigger = message();
    recordIncomingMessageRevision(trigger);
    const { bot, calls } = fakeBot();
    await coordinateAiReply(request(bot, trigger), {
        executeAi: async () => reply(["", "  "]),
    });
    assert.deepEqual(calls.map((call) => call.method), ["text"]);
    assert.equal(calls[0].args[1], "刚才脑子短路了一下。");
    assert.equal(isConversationActive(trigger), false);
});

test("one, two and three messages are sent in serial order", async () => {
    for (const count of [1, 2, 3]) {
        const trigger = message();
        recordIncomingMessageRevision(trigger);
        const calls: string[] = [];
        let inFlight = 0;
        let maxInFlight = 0;
        const bot = {
            sendMarkdown: async (_target: unknown, content: string) => {
                inFlight++;
                maxInFlight = Math.max(maxInFlight, inFlight);
                calls.push(content);
                await new Promise((resolve) => setTimeout(resolve, 1));
                inFlight--;
            },
        } as unknown as QQBot;
        const messages = Array.from({ length: count }, (_, index) => `消息 ${index + 1}`);
        await coordinateAiReply(request(bot, trigger), {
            executeAi: async () => reply(messages), multiMessageDelayMs: 0,
        });
        assert.deepEqual(calls, messages);
        assert.equal(maxInFlight, 1);
    }
});

test("two messages quote only the first after newer group activity", async () => {
    const trigger = message();
    recordIncomingMessageRevision(trigger);
    const { bot, calls } = fakeBot();
    let resolveAi!: (value: AiResult) => void;
    const ai = new Promise<AiResult>((resolve) => { resolveAi = resolve; });
    const pending = coordinateAiReply(request(bot, trigger), {
        executeAi: async () => ai, multiMessageDelayMs: 0,
    });
    const newer = message(trigger.groupId);
    recordIncomingMessageRevision(newer);
    coordinateAiReply(request(bot, newer), { executeAi: async () => ai });
    resolveAi(reply(["第一条", "第二条"], "none"));
    await pending;
    assert.deepEqual(calls.map((call) => call.method), ["send", "markdown"]);
    assert.deepEqual((calls[0].args[0] as { messageReference: unknown }).messageReference,
        { message_id: trigger.id });
    assert.equal(calls[1].args[1], "第二条");
});

test("shared mentions and inline mention tags create real @ only in the first message", async () => {
    const trigger = message();
    recordIncomingMessageRevision(trigger);
    await rememberKnownMember({ ...trigger, author: { member_openid: "member-1", username: "芷" } });
    const { bot, calls } = fakeBot();
    await coordinateAiReply(request(bot, trigger), {
        executeAi: async () => ({ kind: "reply", action: {
            messages: ["第一条", "<mention>芷</mention> 第二条"], mentions: ["芷"], quote: "auto",
        } }),
        multiMessageDelayMs: 0,
    });
    assert.equal(calls.length, 2);
    assert.match(String(calls[0].args[1]), /<qqbot-at-user id="member-1" \/>/);
    assert.equal(calls[1].args[1], "@芷 第二条");
});

test("partial send failure stops later messages and keeps only successful context", async (t) => {
    const trigger = message();
    recordIncomingMessageRevision(trigger);
    const calls: string[] = [];
    let activations = 0;
    t.mock.method(logger, "info", (...values: unknown[]) => {
        if (values[0] === "[Engagement] active") activations++;
    });
    const bot = {
        sendMarkdown: async (_target: unknown, content: string) => {
            calls.push(content);
            if (calls.length === 2) throw new Error("QQ API failed");
        },
    } as unknown as QQBot;
    await coordinateAiReply(request(bot, trigger), {
        executeAi: async () => reply(["第一条", "第二条", "第三条"]), multiMessageDelayMs: 0,
    });
    assert.deepEqual(calls, ["第一条", "第二条"]);
    const context = buildChatInput(trigger, "next");
    assert.match(context, /小尘：第一条/);
    assert.doesNotMatch(context, /小尘：第二条|小尘：第三条/);
    assert.equal(activations, 1);
    assert.equal(isConversationActive(trigger), true);
});

test("successful multi-message reply records separate context entries", async () => {
    const trigger = message();
    recordIncomingMessageRevision(trigger);
    const { bot } = fakeBot();
    await coordinateAiReply(request(bot, trigger), {
        executeAi: async () => reply(["放心，还早呢", "毕竟我又没有身体"]),
        multiMessageDelayMs: 0,
    });
    assert.match(buildChatInput(trigger, "next"), /小尘：放心，还早呢\n小尘：毕竟我又没有身体/);
});

test("cancelling after the first send stops subsequent messages during the delay", async () => {
    const trigger = message();
    recordIncomingMessageRevision(trigger);
    const calls: string[] = [];
    let firstSent!: () => void;
    const first = new Promise<void>((resolve) => { firstSent = resolve; });
    const bot = {
        sendMarkdown: async (_target: unknown, content: string) => {
            calls.push(content);
            if (calls.length === 1) firstSent();
        },
    } as unknown as QQBot;
    const pending = coordinateAiReply(request(bot, trigger), {
        executeAi: async () => reply(["第一条", "第二条", "第三条"]),
        multiMessageDelayMs: 1_000,
    });
    await first;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cancelPendingRequestByMessageId(trigger.id!), 1);
    await pending;
    assert.deepEqual(calls, ["第一条"]);
    assert.match(buildChatInput(trigger, "next"), /小尘：第一条/);
});

test("AI deadline ends at generation, before the inter-message delay", async () => {
    const trigger = message();
    recordIncomingMessageRevision(trigger);
    const { bot, calls } = fakeBot();
    await coordinateAiReply(request(bot, trigger), {
        executeAi: async () => reply(["第一条", "第二条"]),
        timeoutMs: 10,
        multiMessageDelayMs: 20,
    });
    assert.deepEqual(calls.map((call) => call.args[1]), ["第一条", "第二条"]);
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
    const newer = message(trigger.groupId);
    recordIncomingMessageRevision(newer);
    coordinateAiReply(request(bot, newer), { executeAi: async () => ai });
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
            return new Promise<AiResult>((resolve, reject) => {
                options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
                ai.then(resolve, reject);
            });
        },
        timeoutMs: 10,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await pending;
    assert.equal(signal.aborted, true);
    assert.deepEqual(calls.map((call) => call.method), ["text"]);
    assert.equal(calls[0].args[1], AI_TIMEOUT_REPLY);
    assert.match(buildChatInput(trigger, "next"), new RegExp(AI_TIMEOUT_REPLY));
    assert.equal(isConversationActive(trigger), false);

    resolveAi(reply("too late"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls.length, 1);
    assert.equal(cancelPendingRequestByMessageId(trigger.id!), 0);
});

test("NO_REPLY sends nothing, exits engagement, and clears the deadline", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const trigger = message();
    recordIncomingMessageRevision(trigger);
    const { bot, calls } = fakeBot();
    await coordinateAiReply({ ...request(bot, trigger), allowNoReply: true, triggerPriority: 1 },
        { executeAi: async () => ({ kind: "no_reply" }) });
    assert.equal(calls.length, 0);
    assert.equal(isConversationActive(trigger), false);
    t.mock.timers.tick(30_001);
    assert.equal(calls.length, 0);
    t.mock.timers.reset();
});

test("hard deadline aborts an unfinished request at exactly 30 seconds", async (t) => {
    let now = 1_000;
    t.mock.method(Date, "now", () => now);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const trigger = message();
    recordIncomingMessageRevision(trigger);
    const { bot, calls } = fakeBot();
    let signal!: AbortSignal;
    const pending = coordinateAiReply(request(bot, trigger), {
        executeAi: async (_input, options) => {
            signal = options.signal;
            return new Promise<AiResult>((_resolve, reject) => {
                options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
            });
        },
    });
    await Promise.resolve();
    now += 29_999;
    t.mock.timers.tick(29_999);
    assert.equal(signal.aborted, false);
    assert.equal(calls.length, 0);
    now += 1;
    t.mock.timers.tick(1);
    await pending;
    assert.equal(signal.aborted, true);
    assert.deepEqual(calls.map((call) => call.method), ["text"]);
    assert.equal(calls[0].args[1], AI_TIMEOUT_REPLY);
    t.mock.timers.reset();
});

test("an overdue result is discarded even before a delayed timer callback runs", async (t) => {
    let now = 1_000;
    t.mock.method(Date, "now", () => now);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const trigger = message();
    recordIncomingMessageRevision(trigger);
    const { bot, calls } = fakeBot();
    let resolveAi!: (value: AiResult) => void;
    let signal!: AbortSignal;
    const ai = new Promise<AiResult>((resolve) => { resolveAi = resolve; });
    const pending = coordinateAiReply(request(bot, trigger), {
        executeAi: async (_input, options) => {
            signal = options.signal;
            return ai;
        },
    });
    await Promise.resolve();
    now += 30_001;
    resolveAi(reply("too late"));
    await pending;
    assert.equal(signal.aborted, true);
    assert.deepEqual(calls.map((call) => call.args[1]), [AI_TIMEOUT_REPLY]);
    t.mock.timers.reset();
});

test("structured 520 and retryable 503 produce the upstream fallback promptly", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    for (const upstreamError of [
        Object.assign(new Error("origin failed"), { status: 520, error: { retryable: true, retry_after: 60 } }),
        Object.assign(new Error("unavailable"), { status: 503 }),
    ]) {
        const trigger = message();
        recordIncomingMessageRevision(trigger);
        const { bot, calls } = fakeBot();
        await coordinateAiReply(request(bot, trigger), {
            executeAi: async () => { throw upstreamError; },
        });
        assert.deepEqual(calls.map((call) => call.method), ["text"]);
        assert.equal(calls[0].args[1], AI_UPSTREAM_ERROR_REPLY);
        assert.equal(isConversationActive(trigger), false);
        t.mock.timers.tick(30_001);
        assert.equal(calls.length, 1);
    }
    assert.equal(classifyUpstreamFailure({ error: { retryable: true } })?.retryable, true);
    assert.equal(classifyUpstreamFailure({ code: "server_error" })?.retryable, true);
    assert.equal(classifyUpstreamFailure(new AiResponseFailure({ code: "server_error" }))?.retryable, true);
    for (const status of [502, 504, 520]) {
        assert.equal(classifyUpstreamFailure({ status })?.retryable, true);
    }
    assert.equal(classifyUpstreamFailure({ status: 400 }), null);
    t.mock.timers.reset();
});

test("upstream fallback quotes the trigger after a newer group message", async () => {
    const trigger = message();
    recordIncomingMessageRevision(trigger);
    const { bot, calls } = fakeBot();
    let rejectAi!: (error: unknown) => void;
    const ai = new Promise<AiResult>((_resolve, reject) => { rejectAi = reject; });
    const pending = coordinateAiReply(request(bot, trigger), { executeAi: async () => ai });
    const newer = message(trigger.groupId);
    recordIncomingMessageRevision(newer);
    coordinateAiReply(request(bot, newer), { executeAi: async () => ai });
    rejectAi({ status: 520, retryable: true });
    await pending;
    assert.deepEqual(calls.map((call) => call.method), ["send"]);
    const payload = calls[0].args[0] as { markdown: { content: string }; messageReference: { message_id: string } };
    assert.equal(payload.markdown.content, AI_UPSTREAM_ERROR_REPLY);
    assert.equal(payload.messageReference.message_id, trigger.id);
});

test("web search notice is followed by timeout fallback", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const trigger = message();
    recordIncomingMessageRevision(trigger);
    const { bot, calls } = fakeBot();
    const work = request(bot, trigger);
    work.onWebSearchStart = async () => { await bot.sendText(trigger.replyTarget, "稍等，我查一下。"); };
    let signal!: AbortSignal;
    const pending = coordinateAiReply(work, {
        executeAi: async (_input, options) => {
            signal = options.signal;
            await options.onWebSearchStart?.();
            return new Promise<AiResult>((_resolve, reject) => {
                options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
            });
        },
        webSearchTimeoutMs: 30_000,
    });
    await Promise.resolve();
    await Promise.resolve();
    t.mock.timers.tick(30_000);
    await pending;
    assert.equal(signal.aborted, true);
    assert.deepEqual(calls.map((call) => call.args[1]), ["稍等，我查一下。", AI_WEB_SEARCH_TIMEOUT_REPLY]);
    t.mock.timers.reset();
});

test("unknown AI error keeps the ordinary failure notice", async () => {
    const trigger = message();
    const { bot, calls } = fakeBot();
    await coordinateAiReply(request(bot, trigger), {
        executeAi: async () => { throw new TypeError("local bug"); },
    });
    assert.deepEqual(calls.map((call) => call.method), ["text"]);
    assert.equal(calls[0].args[1], "刚才脑子短路了一下。");
});

test("recall just before the deadline wins without a fallback", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const trigger = message();
    recordIncomingMessageRevision(trigger);
    const { bot, calls } = fakeBot();
    let signal!: AbortSignal;
    const pending = coordinateAiReply(request(bot, trigger), {
        executeAi: async (_input, options) => {
            signal = options.signal;
            return new Promise<AiResult>((_resolve, reject) => {
                options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
            });
        },
    });
    await Promise.resolve();
    t.mock.timers.tick(29_900);
    assert.equal(cancelPendingRequestByMessageId(trigger.id!), 1);
    t.mock.timers.tick(200);
    await pending;
    assert.equal(signal.aborted, true);
    assert.equal(calls.length, 0);
    t.mock.timers.reset();
});

test("recall during asynchronous mention rendering prevents QQ send", async () => {
    const trigger = message();
    recordIncomingMessageRevision(trigger);
    const { bot, calls } = fakeBot();
    let release!: () => void;
    let markStarted!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    class SlowRepository extends MemoryMemberRepository {
        override async findByUsername(groupId: string, username: string) {
            markStarted();
            await gate;
            return super.findByUsername(groupId, username);
        }
    }
    configureMemberRepository(new SlowRepository());
    try {
        const pending = coordinateAiReply(request(bot, trigger), {
            executeAi: async () => ({ ...reply("你好"), action: { messages: ["你好"], mentions: ["芷"], quote: "auto" } }),
        });
        await started;
        assert.equal(cancelPendingRequestByMessageId(trigger.id!), 1);
        release();
        await pending;
        assert.equal(calls.length, 0);
    } finally {
        release();
        configureMemberRepository(new MemoryMemberRepository());
    }
});

test("two different triggers remain independent", async () => {
    const firstTrigger = message();
    const secondTrigger = message();
    recordIncomingMessageRevision(firstTrigger);
    const { bot, calls } = fakeBot();
    let resolveFirst!: (value: AiResult) => void;
    let resolveSecond!: (value: AiResult) => void;
    const firstAi = new Promise<AiResult>((resolve) => { resolveFirst = resolve; });
    const secondAi = new Promise<AiResult>((resolve) => { resolveSecond = resolve; });
    const first = coordinateAiReply(request(bot, firstTrigger), { executeAi: async () => firstAi });
    recordIncomingMessageRevision(secondTrigger);
    const second = coordinateAiReply(request(bot, secondTrigger), { executeAi: async () => secondAi });
    await Promise.resolve();
    assert.equal(cancelPendingRequestByMessageId(firstTrigger.id!), 1);
    resolveFirst(reply("late"));
    resolveSecond(reply("second"));
    await Promise.all([first, second]);
    assert.deepEqual(calls.map((call) => call.method), ["markdown"]);
    assert.equal(calls[0].args[1], "second");
    assert.equal(cancelPendingRequestByMessageId(secondTrigger.id!), 0);
});

test("recall removes only the matching message ID from context", () => {
    const target = message();
    const other = message(target.groupId);
    rememberIncomingMessage(target, "同一句话");
    rememberIncomingMessage(other, "同一句话");
    assert.equal(removeMessageFromContext(getConversationKey(target), target.id!), true);
    assert.equal(removeMessageFromContext(getConversationKey(target), target.id!), false);
    const input = buildChatInput(other, "继续");
    assert.equal((input.match(/同一句话/g) ?? []).length, 1);
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
    resolveAi(reply("too late"));
    await pending;
    assert.equal(signal.aborted, true);
    assert.equal(calls.length, 0);
    assert.doesNotMatch(buildChatInput(trigger, "next"), /小尘 ping/);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(calls.length, 0);
});

test("one recalled trigger cancels every matching pending request", async () => {
    const trigger = message();
    recordIncomingMessageRevision(trigger);
    const { bot, calls } = fakeBot();
    const first = coordinateAiReply(request(bot, trigger), {
        executeAi: async (_input, options) => new Promise<AiResult>((_resolve, reject) => {
            options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
        timeoutMs: 100,
    });
    const second = coordinateAiReply(request(bot, trigger), {
        executeAi: async () => { throw new Error("same conversation must not start a second request"); },
        timeoutMs: 100,
    });
    await Promise.resolve();
    assert.equal(cancelPendingRequestByMessageId(trigger.id!), 1);
    await Promise.all([first, second]);
    assert.equal(calls.length, 0);
});
