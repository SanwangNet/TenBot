import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { QQBot } from "@tencent-connect/qqbot-nodejs";
import type { AiResult } from "../src/ai/reply-result.js";
import { buildReplyCycleContext, recordIncomingMessageRevision, rememberIncomingMessage } from "../src/qq/conversation/recent-context.js";
import type { NormalizedQqMessage } from "../src/qq/message/normalize-message.js";
import { coordinateAiReply, AI_TIMEOUT_REPLY, AI_WEB_SEARCH_TIMEOUT_REPLY } from "../src/qq/reply/coordinator.js";

type RecordedAttempt = { input: string; signal: AbortSignal; resolve: (result: AiResult) => void };
function message(groupId = randomUUID(), content = "A"): NormalizedQqMessage {
    return {
        source: {} as never, id: randomUUID(), kind: "group", eventType: "GROUP_MESSAGE_CREATE",
        content, displayContent: content, groupId, author: null, authorId: "user",
        authorName: "user", authorIsBot: false, mentions: [], attachments: [],
        replyTarget: { scope: "group", targetId: groupId, msgId: randomUUID() },
        raw: {},
    } as NormalizedQqMessage;
}
function commit(value: NormalizedQqMessage): number {
    const revision = recordIncomingMessageRevision(value);
    rememberIncomingMessage(value, value.displayContent);
    return revision;
}
function fakeBot() {
    const calls: Array<{ method: string; content?: string; payload?: unknown }> = [];
    const bot = {
        async sendText(_target: unknown, content: string) { calls.push({ method: "text", content }); },
        async sendMarkdown(_target: unknown, content: string) { calls.push({ method: "markdown", content }); },
        async send(payload: unknown) { calls.push({ method: "send", payload }); },
    } as unknown as QQBot;
    return { bot, calls };
}
function requestFor(bot: QQBot, value: NormalizedQqMessage, priority: 0 | 1 | 2 | 3 = 3, allowNoReply = priority < 3) {
    return {
        bot, message: value, aiInput: value.displayContent, imageUrls: [], isGroup: true, allowNoReply,
        triggerPriority: priority, isAtBot: priority === 3, mentionedByName: priority === 2,
        onWebSearchStart: async () => { await bot.sendText(value.replyTarget, "search notice"); },
        buildAttempt: async (current: NormalizedQqMessage, context: { allowNoReply: boolean }) => ({
            aiInput: buildReplyCycleContext(current) + "\nallowNoReply=" + context.allowNoReply,
            imageUrls: [],
        }),
    };
}
async function waitFor(check: () => boolean, timeout = 1500): Promise<void> {
    const started = Date.now();
    while (!check()) {
        if (Date.now() - started > timeout) throw new Error("condition timed out");
        await new Promise((resolve) => setTimeout(resolve, 2));
    }
}
function controlledAttempts(records: RecordedAttempt[]) {
    return async (input: string, options: { signal: AbortSignal }): Promise<AiResult> =>
        await new Promise<AiResult>((resolve, reject) => {
            records.push({ input, signal: options.signal, resolve });
            const abort = () => reject(new Error("aborted"));
            if (options.signal.aborted) abort();
            else options.signal.addEventListener("abort", abort, { once: true });
        });
}
const reply = (content: string): AiResult => ({
    kind: "reply", action: { messages: [content], mentions: [], quote: "auto" },
});

test("new message aborts generation and the replacement sees current context once", async () => {
    const group = randomUUID();
    const a = message(group, "A asks");
    const b = message(group, "B adds context");
    commit(a);
    const { bot } = fakeBot();
    const attempts: RecordedAttempt[] = [];
    const deps = { executeAi: controlledAttempts(attempts) };
    const first = coordinateAiReply(requestFor(bot, a), deps);
    await waitFor(() => attempts.length === 1);
    commit(b);
    const second = coordinateAiReply(requestFor(bot, b, 0), deps);
    await waitFor(() => attempts.length === 2);
    assert.equal(attempts[0].signal.aborted, true);
    assert.match(attempts[1].input, /A asks/);
    assert.match(attempts[1].input, /B adds context/);
    assert.equal((attempts[1].input.match(/B adds context/g) ?? []).length, 1);
    attempts[1].resolve(reply("updated"));
    await Promise.all([first, second]);
});

test("three interruptions cap, trailing messages schedule a fresh cycle and reset budget", async () => {
    const group = randomUUID();
    const messages = ["A", "B", "C", "D", "E", "F", "G", "H"].map((text) => message(group, text));
    commit(messages[0]);
    const { bot } = fakeBot();
    const attempts: RecordedAttempt[] = [];
    const deps = { executeAi: controlledAttempts(attempts) };
    const first = coordinateAiReply(requestFor(bot, messages[0]), deps);
    await waitFor(() => attempts.length === 1);

    for (let index = 1; index <= 3; index++) {
        commit(messages[index]);
        coordinateAiReply(requestFor(bot, messages[index], index === 3 ? 3 : 0), deps);
        await waitFor(() => attempts.length === index + 1);
        assert.equal(attempts[index - 1].signal.aborted, true);
    }
    assert.equal(attempts.length, 4);

    for (let index = 4; index <= 6; index++) {
        commit(messages[index]);
        coordinateAiReply(requestFor(bot, messages[index], 0), deps);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(attempts.length, 4);
    assert.equal(attempts[3].signal.aborted, false);
    attempts[3].resolve(reply("cycle one"));
    await waitFor(() => attempts.length === 5);
    assert.equal(attempts[4].signal.aborted, false);
    for (const text of ["E", "F", "G"]) assert.match(attempts[4].input, new RegExp(text));
    assert.match(attempts[4].input, /allowNoReply=true/);

    commit(messages[7]);
    const secondCycle = coordinateAiReply(requestFor(bot, messages[7], 0), deps);
    await waitFor(() => attempts.length === 6);
    assert.equal(attempts[4].signal.aborted, true);
    assert.match(attempts[5].input, /H/);
    attempts[5].resolve({ kind: "no_reply" });
    await Promise.all([first, secondCycle]);
});

test("hard trigger arriving during soft generation upgrades no-reply policy", async () => {
    const group = randomUUID();
    const soft = message(group, "chat continues");
    const hard = message(group, "@\u5c0f\u5c18 answer this");
    commit(soft);
    const { bot } = fakeBot();
    const attempts: RecordedAttempt[] = [];
    const contexts: string[] = [];
    const softRequest = requestFor(bot, soft, 1, true);
    softRequest.buildAttempt = async (current, context) => {
        contexts.push(String(context.allowNoReply));
        return { aiInput: buildReplyCycleContext(current) + "\nallowNoReply=" + context.allowNoReply, imageUrls: [] };
    };
    const first = coordinateAiReply(softRequest, { executeAi: controlledAttempts(attempts) });
    await waitFor(() => attempts.length === 1);
    commit(hard);
    const hardRequest = requestFor(bot, hard, 3, false);
    hardRequest.buildAttempt = softRequest.buildAttempt;
    coordinateAiReply(hardRequest);
    await waitFor(() => attempts.length === 2);
    assert.deepEqual(contexts, ["true", "false"]);
    attempts[1].resolve(reply("answer"));
    await first;
});

test("ordinary deadline is shared by restarted attempts", async () => {
    const group = randomUUID();
    const a = message(group, "question");
    const b = message(group, "more");
    commit(a);
    const { bot, calls } = fakeBot();
    const attempts: RecordedAttempt[] = [];
    const started = Date.now();
    const pending = coordinateAiReply(requestFor(bot, a), {
        executeAi: controlledAttempts(attempts), timeoutMs: 90,
    });
    await waitFor(() => attempts.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 35));
    commit(b);
    coordinateAiReply(requestFor(bot, b, 0));
    await waitFor(() => attempts.length === 2);
    await pending;
    const elapsed = Date.now() - started;
    assert.equal(attempts[1].signal.aborted, true);
    assert.ok(elapsed < 250, "cycle should keep the original 90 ms budget");
    assert.ok(calls.some((call) => call.content === AI_TIMEOUT_REPLY || (call.payload as any)?.markdown?.content === AI_TIMEOUT_REPLY));
});

test("web search extends one cycle to its original 120-second budget and uses the exact timeout notice", async () => {
    const group = randomUUID();
    const a = message(group, "search this");
    const b = message(group, "one more detail");
    commit(a);
    const { bot, calls } = fakeBot();
    const attempts: RecordedAttempt[] = [];
    const started = Date.now();
    let call = 0;
    const pending = coordinateAiReply(requestFor(bot, a), {
        timeoutMs: 70,
        webSearchTimeoutMs: 190,
        executeAi: async (_input, options) => {
            call++;
            attempts.push({ input: _input, signal: options.signal, resolve: () => {} });
            if (call === 1) await options.onWebSearchStart?.();
            return await new Promise<AiResult>((_resolve, reject) => {
                const abort = () => reject(new Error("aborted"));
                if (options.signal.aborted) abort();
                else options.signal.addEventListener("abort", abort, { once: true });
            });
        },
    });
    await waitFor(() => attempts.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 35));
    commit(b);
    coordinateAiReply(requestFor(bot, b, 0));
    await waitFor(() => attempts.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.ok(Date.now() - started > 70);
    assert.equal(calls.filter((item) => item.content === AI_WEB_SEARCH_TIMEOUT_REPLY).length, 0);
    await pending;
    assert.equal(attempts[1].signal.aborted, true);
    assert.deepEqual(calls.map((item) => item.content ?? (item.payload as any)?.markdown?.content).filter(Boolean), ["search notice", AI_WEB_SEARCH_TIMEOUT_REPLY]);
});

test("NO_REPLY consumes only its snapshot and trailing messages still get a new cycle", async () => {
    const group = randomUUID();
    const values = ["A", "B", "C", "D", "E", "F"].map((text) => message(group, text));
    commit(values[0]);
    const { bot, calls } = fakeBot();
    const attempts: RecordedAttempt[] = [];
    const deps = { executeAi: controlledAttempts(attempts) };
    const first = coordinateAiReply(requestFor(bot, values[0], 1), deps);
    await waitFor(() => attempts.length === 1);
    for (let index = 1; index <= 3; index++) {
        commit(values[index]);
        coordinateAiReply(requestFor(bot, values[index], 0), deps);
        await waitFor(() => attempts.length === index + 1);
    }
    commit(values[4]);
    coordinateAiReply(requestFor(bot, values[4], 0), deps);
    attempts[3].resolve({ kind: "no_reply" });
    await waitFor(() => attempts.length === 5);
    assert.match(attempts[4].input, /E/);
    commit(values[5]);
    const second = coordinateAiReply(requestFor(bot, values[5], 0), deps);
    await waitFor(() => attempts.length === 6);
    assert.equal(attempts[4].signal.aborted, true);
    attempts[5].resolve({ kind: "no_reply" });
    await Promise.all([first, second]);
    assert.equal(calls.length, 0);
});

test("new messages during the QQ send phase do not abort an already completed action", async () => {
    const group = randomUUID();
    const a = message(group, "start");
    const b = message(group, "arrived while sending");
    commit(a);
    const calls: string[] = [];
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const sending = new Promise<void>((resolve) => { started = resolve; });
    const bot = {
        async sendMarkdown(_target: unknown, text: string) {
            calls.push(text);
            if (text === "one") { started(); await gate; }
        },
        async sendText() {},
    } as unknown as QQBot;
    const attempts: RecordedAttempt[] = [];
    let count = 0;
    const pending = coordinateAiReply(requestFor(bot, a), {
        executeAi: async (input, options) => {
            attempts.push({ input, signal: options.signal, resolve: () => {} });
            count++;
            return count === 1 ? reply("one") : { kind: "no_reply" };
        },
        multiMessageDelayMs: 0,
    });
    await sending;
    commit(b);
    coordinateAiReply(requestFor(bot, b, 0));
    assert.equal(attempts[0].signal.aborted, false);
    release();
    await pending;
    await waitFor(() => attempts.length === 2);
    assert.deepEqual(calls, ["one"]);
});

test("deadline settles a cycle even when the upstream promise ignores abort", async () => {
    const value = message(randomUUID(), "unresponsive upstream");
    commit(value);
    const { bot, calls } = fakeBot();
    let signal!: AbortSignal;
    await coordinateAiReply(requestFor(bot, value), {
        timeoutMs: 20,
        executeAi: async (_input, options) => {
            signal = options.signal;
            return await new Promise<AiResult>(() => {});
        },
    });
    assert.equal(signal.aborted, true);
    assert.ok(calls.some((call) => call.content === AI_TIMEOUT_REPLY ||
        (call.payload as any)?.markdown?.content === AI_TIMEOUT_REPLY));
});

test("attempt setup failure does not spawn endless trailing cycles", async () => {
    const value = message(randomUUID(), "bad setup");
    commit(value);
    const { bot } = fakeBot();
    let builds = 0;
    const request = requestFor(bot, value);
    request.buildAttempt = async () => {
        builds++;
        throw new Error("setup failed");
    };
    await coordinateAiReply(request);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(builds, 1);
});
