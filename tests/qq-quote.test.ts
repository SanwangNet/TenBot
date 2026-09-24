import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { quoteRef, type MiddlewareContext, type QQBot, type QQBotInboundMessage } from "@tencent-connect/qqbot-nodejs";
import { dispatchEvent } from "@tencent-connect/qqbot-nodejs/protocol";
import type { AiResult } from "../src/ai/reply-result.js";
import { buildReplyCycleSnapshot, getMessageRevision, recordIncomingMessageRevision, rememberBotReply, rememberIncomingMessage } from "../src/qq/conversation/recent-context.js";
import { rememberKnownMember } from "../src/qq/conversation/known-members.js";
import { normalizeQqMessage, type NormalizedQqMessage } from "../src/qq/message/normalize-message.js";
import { coordinateAiReply } from "../src/qq/reply/coordinator.js";
import { registerMessageHandler } from "../src/qq/handlers/message-handler.js";
import { parseQqReplyArguments, qqReplyTool, type QQReplyMessage, type QuotePreference } from "../src/skills/qq-reply/skill.js";

function inbound(group: string, id: string, content: string, idx: string, ref?: string, author = "用户"): QQBotInboundMessage {
    const event = {
        id, content, timestamp: new Date().toISOString(), group_openid: group,
        author: { member_openid: randomUUID(), username: author },
        message_scene: { ext: [`msg_idx=${idx}`, ...(ref ? [`ref_msg_idx=${ref}`] : [])] },
        ...(ref ? { message_type: 103, msg_elements: [{ msg_idx: ref, content: "我今晚不去了" }] } : {}),
    };
    const result = dispatchEvent("GROUP_MESSAGE_CREATE", event, "offline");
    assert.equal(result.action, "message");
    if (result.action !== "message") throw new Error("fixture was not a message");
    return { ...result.msg, replyTarget: { scope: "group", targetId: group, msgId: id } } as QQBotInboundMessage;
}
function context(message: QQBotInboundMessage): MiddlewareContext {
    return { message, state: {}, log: { debug() {} } } as unknown as MiddlewareContext;
}
function commit(message: NormalizedQqMessage): void {
    recordIncomingMessageRevision(message);
    rememberIncomingMessage(message, message.displayContent);
}
function bot() {
    const calls: Array<{ method: string; payload?: any; text?: string }> = [];
    let sequence = 0;
    const fake = {
        async send(payload: unknown) { calls.push({ method: "send", payload }); return { id: `bot-${++sequence}`, ext_info: { ref_idx: `bot-idx-${sequence}` } }; },
        async sendMarkdown(_target: unknown, text: string) { calls.push({ method: "markdown", text }); return { id: `bot-${++sequence}`, ext_info: { ref_idx: `bot-idx-${sequence}` } }; },
        async sendText(_target: unknown, text: string) { calls.push({ method: "text", text }); return { id: `bot-${++sequence}` }; },
    } as unknown as QQBot;
    return { fake, calls };
}
function request(fake: QQBot, message: NormalizedQqMessage) {
    return { bot: fake, message, aiInput: "", imageUrls: [], isGroup: true, allowNoReply: false,
        onWebSearchStart() {},
        buildAttempt: async (current: NormalizedQqMessage) => {
            const snapshot = buildReplyCycleSnapshot(current);
            return { aiInput: snapshot.text, imageUrls: [], refs: snapshot.refs };
        },
    };
}
const answer = (quote: QuotePreference, messages = ["回答"]): AiResult =>
    ({ kind: "reply", action: { messages: messages.map((content, index) => ({
        content, quote: index === 0 ? quote : { mode: "none", ref: null },
    })), mentions: [] } });
const multi = (messages: QQReplyMessage[], mentions: string[] = []): AiResult =>
    ({ kind: "reply", action: { messages, mentions } });

test("strict qq_reply schema uses semantic quote objects and normalizes legacy input", () => {
    const schema = qqReplyTool.parameters.properties.messages.items.properties.quote;
    assert.equal(schema.type, "object");
    assert.deepEqual(schema.required, ["mode", "ref"]);
    assert.equal(JSON.stringify(schema).includes("message_id"), false);
    assert.deepEqual(qqReplyTool.parameters.properties.messages.items.required, ["content", "quote"]);
    assert.deepEqual(qqReplyTool.parameters.required, ["messages", "mentions"]);
    assert.deepEqual(parseQqReplyArguments('{"messages":["好"],"mentions":[],"quote":{"mode":"message","ref":"m2"}}')?.messages[0].quote,
        { mode: "message", ref: "m2" });
    assert.deepEqual(parseQqReplyArguments('{"messages":["好"],"mentions":[],"quote":"trigger"}')?.messages[0].quote,
        { mode: "auto", ref: null });
    assert.deepEqual(parseQqReplyArguments('{"messages":["a","b"],"mentions":[],"quote":{"mode":"message","ref":"m1"}}')?.messages,
        [{ content: "a", quote: { mode: "message", ref: "m1" } }, { content: "b", quote: { mode: "none", ref: null } }]);
});

test("two QQ messages independently quote m2 and m4", async () => {
    const group = randomUUID();
    const messages = await Promise.all([1, 2, 3, 4].map((n) =>
        normalizeQqMessage({}, inbound(group, `real-${n}`, `line ${n}`, `idx-${n}`))));
    messages.forEach(commit);
    await rememberKnownMember({ ...messages[3], author: { member_openid: "member-1", username: "芷" } });
    const { fake, calls } = bot();
    await coordinateAiReply(request(fake, messages[3]), { executeAi: async () => multi([
        { content: "第一条", quote: { mode: "message", ref: "m2" } },
        { content: "第二条", quote: { mode: "message", ref: "m4" } },
    ], ["芷"]), multiMessageDelayMs: 0 });
    assert.deepEqual(calls.map((call) => call.payload?.messageReference?.message_id), ["real-2", "real-4"]);
    assert.match(calls[0].payload.markdown.content, /<qqbot-at-user id="member-1" \/>/);
    assert.doesNotMatch(calls[1].payload.markdown.content, /qqbot-at-user/);
});

test("quote targets are frozen before send; a new message during sending goes to trailing cycle", async () => {
    for (const secondQuote of [{ mode: "message", ref: "m4" }, { mode: "auto", ref: null }] as QuotePreference[]) {
        const group = randomUUID();
        const messages = await Promise.all([1, 2, 3, 4].map((n) =>
            normalizeQqMessage({}, inbound(group, `real-${n}`, `line ${n}`, `idx-${n}`))));
        messages.forEach(commit);
        const e = await normalizeQqMessage({}, inbound(group, "real-E", "newer", "idx-E"));
        const calls: Array<{ method: string; reference?: string }> = [];
        let first = true;
        const fake = {
            async send(payload: any) {
                calls.push({ method: "send", reference: payload.messageReference?.message_id });
                if (first) { first = false; commit(e); }
                return { id: `bot-${calls.length}` };
            },
            async sendMarkdown() {
                calls.push({ method: "markdown" });
                if (first) { first = false; commit(e); }
                return { id: `bot-${calls.length}` };
            },
        } as unknown as QQBot;
        let executions = 0;
        await coordinateAiReply(request(fake, messages[3]), { executeAi: async () => {
            executions++;
            return executions === 1 ? multi([
                { content: "第一条", quote: { mode: "message", ref: "m2" } },
                { content: "第二条", quote: secondQuote },
            ]) : { kind: "no_reply" };
        }, multiMessageDelayMs: 0 });
        assert.deepEqual(calls.slice(0, 2), [
            { method: "send", reference: "real-2" },
            secondQuote.mode === "message" ? { method: "send", reference: "real-4" } : { method: "markdown" },
        ]);
    }
});

test("none, exact message, and auto resolve independently", async () => {
    const group = randomUUID();
    const messages = await Promise.all([1, 2, 3].map((n) =>
        normalizeQqMessage({}, inbound(group, `real-${n}`, `line ${n}`, `idx-${n}`))));
    messages.forEach(commit);
    const { fake, calls } = bot();
    let finish!: (value: AiResult) => void;
    let attempts = 0;
    const pending = coordinateAiReply(request(fake, messages[2]), {
        executeAi: async () => {
            if (++attempts > 1) return { kind: "no_reply" };
            return new Promise<AiResult>((resolve) => { finish = resolve; });
        }, multiMessageDelayMs: 0,
    });
    await Promise.resolve();
    recordIncomingMessageRevision(await normalizeQqMessage({}, inbound(group, "later", "newer", "idx-later")));
    finish(multi([
        { content: "一", quote: { mode: "none", ref: null } },
        { content: "二", quote: { mode: "message", ref: "m2" } },
        { content: "三", quote: { mode: "auto", ref: null } },
    ]));
    await pending;
    assert.deepEqual(calls.map((call) => call.method), ["markdown", "send", "send"]);
    assert.equal(calls[1].payload.messageReference.message_id, "real-2");
    assert.equal(calls[2].payload.messageReference.message_id, "real-3");
});

test("invalid first ref falls back to auto while second valid ref still resolves", async () => {
    const group = randomUUID();
    const messages = await Promise.all([1, 2].map((n) =>
        normalizeQqMessage({}, inbound(group, `real-${n}`, `line ${n}`, `idx-${n}`))));
    messages.forEach(commit);
    const { fake, calls } = bot();
    let finish!: (value: AiResult) => void;
    let attempts = 0;
    const pending = coordinateAiReply(request(fake, messages[1]), {
        executeAi: async () => {
            if (++attempts > 1) return { kind: "no_reply" };
            return new Promise<AiResult>((resolve) => { finish = resolve; });
        }, multiMessageDelayMs: 0,
    });
    await Promise.resolve();
    recordIncomingMessageRevision(await normalizeQqMessage({}, inbound(group, "later", "newer", "idx-later")));
    finish(multi([
        { content: "一", quote: { mode: "message", ref: "m99" } },
        { content: "二", quote: { mode: "message", ref: "m2" } },
    ]));
    await pending;
    assert.deepEqual(calls.map((call) => call.payload?.messageReference?.message_id), ["real-2", "real-2"]);
    assert.equal(JSON.stringify(calls).includes("m99"), false);
});

test("attempt refs expose m1-m3 without transport IDs and can quote m2 or m3", async () => {
    for (const selected of [2, 3]) {
        const group = randomUUID();
        const messages = await Promise.all([1, 2, 3].map((n) => normalizeQqMessage({}, inbound(group, `real-secret-${n}`, `line ${n}`, `idx-${n}`))));
        messages.forEach(commit);
        const snapshot = buildReplyCycleSnapshot(messages[2]);
        assert.match(snapshot.text, /\[m1\].*line 1/);
        assert.match(snapshot.text, /\[m2\].*line 2/);
        assert.match(snapshot.text, /\[m3\].*line 3/);
        assert.doesNotMatch(snapshot.text, /real-secret|idx-|group_openid|member_openid/);
        const { fake, calls } = bot();
        await coordinateAiReply(request(fake, messages[2]), { executeAi: async () => answer({ mode: "message", ref: `m${selected}` }, ["first", "second"]), multiMessageDelayMs: 0 });
        assert.equal(calls[0].payload.messageReference.message_id, `real-secret-${selected}`);
        assert.equal(calls[1].method, "markdown");
        assert.equal(buildReplyCycleSnapshot(messages[2]).refs.get("m4"), "bot-1");
    }
});

test("none suppresses delayed quote, auto keeps it, and unknown ref falls back without guessing", async () => {
    for (const [quote, expected] of [
        [{ mode: "none", ref: null }, false],
        [{ mode: "auto", ref: null }, true],
        [{ mode: "message", ref: "m99" }, true],
    ] as const) {
        const group = randomUUID();
        const first = await normalizeQqMessage({}, inbound(group, "anchor-real", "A", "idx-A"));
        commit(first);
        const { fake, calls } = bot();
        let complete!: (value: AiResult) => void;
        let attempts = 0;
        const pending = coordinateAiReply(request(fake, first), {
            executeAi: async () => {
                attempts++;
                if (attempts > 1) return { kind: "no_reply" };
                return await new Promise<AiResult>((resolve) => { complete = resolve; });
            },
        });
        await Promise.resolve();
        const newer = await normalizeQqMessage({}, inbound(group, "later-real", "B", "idx-B"));
        // This message has reached the conversation while the action is being generated.
        recordIncomingMessageRevision(newer);
        complete(answer(quote as QuotePreference));
        await pending;
        assert.equal(calls[0].method === "send", expected);
        if (expected) assert.equal(calls[0].payload.messageReference.message_id, "anchor-real");
        assert.equal(JSON.stringify(calls).includes("m99"), false);
    }
});

test("interrupted attempt cannot send a stale quote map", async () => {
    const group = randomUUID();
    const a = await normalizeQqMessage({}, inbound(group, "real-A", "A", "idx-A"));
    commit(a);
    const { fake, calls } = bot();
    let finishFirst!: (value: AiResult) => void;
    let finishSecond!: (value: AiResult) => void;
    let executions = 0;
    const pending = coordinateAiReply(request(fake, a), { executeAi: async () => {
        executions++;
        return await new Promise<AiResult>((resolve) => { if (executions === 1) finishFirst = resolve; else finishSecond = resolve; });
    } });
    await Promise.resolve();
    const b = await normalizeQqMessage({}, inbound(group, "real-B", "B", "idx-B"));
    commit(b);
    coordinateAiReply(request(fake, b));
    finishFirst(multi([
        { content: "stale one", quote: { mode: "message", ref: "m1" } },
        { content: "stale two", quote: { mode: "auto", ref: null } },
    ]));
    for (let i = 0; i < 20 && executions < 2; i++) await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(executions, 2);
    finishSecond(answer({ mode: "message", ref: "m2" }, ["fresh"]));
    await pending;
    assert.equal(calls.length, 1);
    assert.equal(calls[0].payload.messageReference.message_id, "real-B");
});

test("SDK quoteRef resolves a group reference into one normalized quote layer", async () => {
    const group = randomUUID();
    const middleware = quoteRef({ preferMsgElements: false });
    const a = inbound(group, "real-A", "我今晚不去了", "idx-A", undefined, "尘柒喵");
    await middleware(context(a), async () => {});
    const b = inbound(group, "real-B", "为什么？", "idx-B", "idx-A", "芷");
    const bContext = context(b);
    await middleware(bContext, async () => {});
    const normalized = await normalizeQqMessage(bContext, b);
    assert.deepEqual(normalized.quotedMessage, { authorName: "尘柒喵", content: "我今晚不去了", realMessageId: "real-A" });
    commit(normalized);
    const snapshot = buildReplyCycleSnapshot(normalized);
    assert.match(snapshot.text, /尘柒喵：我今晚不去了/);
    assert.match(snapshot.text, /芷：为什么？/);
    assert.match(snapshot.text, /↳ 引用 m1/);
    assert.doesNotMatch(snapshot.text, /real-A|idx-A/);
});

test("SDK C2C quote keeps content and message ID even without an author name", async () => {
    const user = randomUUID();
    const middleware = quoteRef({ preferMsgElements: false });
    const make = (id: string, content: string, idx: string, ref?: string) => {
        const result = dispatchEvent("C2C_MESSAGE_CREATE", {
            id, content, timestamp: new Date().toISOString(), author: { user_openid: user },
            message_scene: { ext: [`msg_idx=${idx}`, ...(ref ? [`ref_msg_idx=${ref}`] : [])] },
            ...(ref ? { message_type: 103, msg_elements: [{ msg_idx: ref, content: "原话" }] } : {}),
        }, "offline");
        assert.equal(result.action, "message");
        if (result.action !== "message") throw new Error("fixture was not a message");
        return { ...result.msg, replyTarget: { scope: "c2c", targetId: user, msgId: id } } as QQBotInboundMessage;
    };
    const a = make("c2c-A", "原话", "c2c-idx-A");
    await middleware(context(a), async () => {});
    const b = make("c2c-B", "为什么？", "c2c-idx-B", "c2c-idx-A");
    const bContext = context(b);
    await middleware(bContext, async () => {});
    const normalized = await normalizeQqMessage(bContext, b);
    assert.equal(normalized.quotedMessage?.content, "原话");
    assert.equal(normalized.quotedMessage?.realMessageId, "c2c-A");
    assert.equal(normalized.quotedMessage?.authorName, undefined);
});

test("SDK msg_elements fallback shows out-of-context quote and unresolved metadata stays safe", async () => {
    const group = randomUUID();
    const middleware = quoteRef();
    const b = inbound(group, "real-B", "为什么？", "idx-B", "old-idx", "芷");
    const bContext = context(b);
    await middleware(bContext, async () => {});
    const normalized = await normalizeQqMessage(bContext, b);
    assert.equal(normalized.quotedMessage?.content, "我今晚不去了");
    assert.equal(normalized.quotedMessage?.realMessageId, undefined);
    commit(normalized);
    assert.match(buildReplyCycleSnapshot(normalized).text, /引用消息：我今晚不去了/);
    const missing = inbound(group, "real-C", "继续问", "idx-C", "missing", "芷");
    missing.msgElements = [];
    const missingContext = context(missing);
    await middleware(missingContext, async () => {});
    const unresolved = await normalizeQqMessage(missingContext, missing);
    commit(unresolved);
    assert.match(buildReplyCycleSnapshot(unresolved).text, /引用消息内容不可用/);
});

test("quoted image uses a placeholder without exposing or fetching its URL", async () => {
    const group = randomUUID();
    const raw = inbound(group, "real-current", "这是哪张？", "idx-current", "image-idx");
    raw.msgElements = [{ msg_idx: "image-idx", content: "", attachments: [
        { content_type: "image/png", url: "https://example.invalid/private-image" },
    ] }];
    const ctx = context(raw);
    await quoteRef()(ctx, async () => {});
    const normalized = await normalizeQqMessage(ctx, raw);
    assert.equal(normalized.quotedMessage?.content, "[图片]");
    commit(normalized);
    const text = buildReplyCycleSnapshot(normalized).text;
    assert.match(text, /\[图片\]/);
    assert.doesNotMatch(text, /private-image/);
});

test("quoted Bot reply is identified from its send response and only direct relation is expanded", async () => {
    const group = randomUUID();
    const a = await normalizeQqMessage({}, inbound(group, "real-A", "起因", "idx-A"));
    commit(a);
    rememberBotReply(a, "别急，后端炸了而已，我没死", { id: "bot-real", refIdx: "bot-idx" });
    const b = inbound(group, "real-B", "你还挺嘴硬", "idx-B", "bot-idx", "芷");
    const normalized = await normalizeQqMessage(context(b), b);
    assert.equal(normalized.quotedMessage?.authorName, "小尘");
    assert.equal(normalized.quotedMessage?.realMessageId, "bot-real");
    commit(normalized);
    const snapshot = buildReplyCycleSnapshot(normalized);
    assert.match(snapshot.text, /小尘：别急，后端炸了而已，我没死/);
    assert.match(snapshot.text, /↳ 引用 m2/);
    assert.equal(getMessageRevision(normalized), 2);
});

test("a quote of a quoted message renders only the direct relation for the newest message", async () => {
    const group = randomUUID();
    const middleware = quoteRef({ preferMsgElements: false });
    const rawA = inbound(group, "real-A", "A 原话", "idx-A");
    await middleware(context(rawA), async () => {});
    const rawB = inbound(group, "real-B", "B 回答", "idx-B", "idx-A");
    const ctxB = context(rawB);
    await middleware(ctxB, async () => {});
    const b = await normalizeQqMessage(ctxB, rawB);
    commit(b);
    const rawC = inbound(group, "real-C", "C 追问", "idx-C", "idx-B");
    const ctxC = context(rawC);
    await middleware(ctxC, async () => {});
    const c = await normalizeQqMessage(ctxC, rawC);
    assert.deepEqual(c.quotedMessage, { authorName: "用户", content: "B 回答", realMessageId: "real-B" });
    assert.equal(c.quotedMessage?.content?.includes("A 原话"), false);
    commit(c);
    assert.match(buildReplyCycleSnapshot(c).text, /C 追问\n↳ 引用 m\d+/);
});

test("pure QQ face is filtered before revision and context insertion", async () => {
    const group = randomUUID();
    let handler!: (ctx: unknown, message: QQBotInboundMessage) => Promise<void>;
    registerMessageHandler({ on(event: string, callback: typeof handler) {
        if (event === "message") handler = callback;
    } } as unknown as QQBot);
    const passive = inbound(group, "real-passive", "普通聊天", "idx-passive");
    await handler({}, passive);
    const normalized = await normalizeQqMessage({}, passive);
    const before = getMessageRevision(normalized);
    const face = inbound(group, "real-face", "<faceType=1>", "idx-face");
    await handler({}, face);
    assert.equal(getMessageRevision(normalized), before);
    assert.doesNotMatch(buildReplyCycleSnapshot(normalized).text, /faceType|QQ表情/);
});
