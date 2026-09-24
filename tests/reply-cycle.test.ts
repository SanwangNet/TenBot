import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { QQBot } from "@tencent-connect/qqbot-nodejs";
import type { AiResult } from "../src/ai/reply-result.js";
import { buildAutoMemeContext } from "../src/skills/meme/skill.js";
import { buildReplyCycleContext, recordIncomingMessageRevision, rememberIncomingMessage } from "../src/qq/conversation/recent-context.js";
import { getConversationGeneration, isConversationActive, markConversationActive } from "../src/qq/conversation/engagement.js";
import type { NormalizedQqMessage } from "../src/qq/message/normalize-message.js";
import { decideMessageTrigger } from "../src/qq/message/trigger.js";
import { buildReplyCycleMemeQuery, coordinateAiReply, AI_TIMEOUT_REPLY, AI_WEB_SEARCH_TIMEOUT_REPLY, type AttemptBuildContext } from "../src/qq/reply/coordinator.js";

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
        buildAttempt: async (current: NormalizedQqMessage, context: AttemptBuildContext) => ({
            aiInput: buildReplyCycleContext(current) + "\nallowNoReply=" + context.allowNoReply +
                "\norigin=" + context.originTriggerKind + " effective=" + context.effectiveTriggerKind,
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
    kind: "reply", action: { messages: [{ content, quote: { mode: "auto", ref: null } }], mentions: [] },
});

test("hard mention, name, active and Meme text keep distinct trigger semantics", () => {
    const hard = { ...message(randomUUID(), "@小尘 你怎么看"), eventType: "GROUP_AT_MESSAGE_CREATE" } as NormalizedQqMessage;
    const name = message(randomUUID(), "我感觉小尘刚才那句话挺怪的");
    const passive = message(randomUUID(), "kskbl？");
    assert.deepEqual([decideMessageTrigger(hard, false).triggerKind, decideMessageTrigger(hard, false).allowNoReply],
        ["hard-mention", false]);
    assert.deepEqual([decideMessageTrigger(name, false).triggerKind, decideMessageTrigger(name, false).allowNoReply],
        ["name-soft", true]);
    assert.deepEqual([decideMessageTrigger(passive, true).triggerKind, decideMessageTrigger(passive, true).allowNoReply],
        ["active-soft", true]);
    assert.equal(decideMessageTrigger(passive, false).shouldReply, false);
});

test("name-soft NO_REPLY stays optional and does not create or clear engagement", async () => {
    const value = message(randomUUID(), "小尘，干他");
    commit(value);
    const { bot, calls } = fakeBot();
    const attempts: string[] = [];
    const request = requestFor(bot, value, 2);
    request.buildAttempt = async (_message, context) => {
        attempts.push(`${context.originTriggerKind}/${context.effectiveTriggerKind}/${context.allowNoReply}`);
        return { aiInput: value.displayContent, imageUrls: [] };
    };
    await coordinateAiReply(request, { executeAi: async () => ({ kind: "no_reply" }) });
    assert.deepEqual(attempts, ["name-soft/name-soft/true"]);
    assert.equal(calls.length, 0);
    assert.equal(isConversationActive(value), false);
    markConversationActive(value);
    const generation = getConversationGeneration(value);
    await coordinateAiReply(request, { executeAi: async () => ({ kind: "no_reply" }) });
    assert.equal(isConversationActive(value), true);
    assert.equal(getConversationGeneration(value), generation);
});

test("name-soft reply activates conversation", async () => {
    const value = message(randomUUID(), "小尘，干他");
    commit(value);
    const { bot, calls } = fakeBot();
    await coordinateAiReply(requestFor(bot, value, 2), { executeAi: async () => reply("收到") });
    assert.equal(calls.length, 1);
    assert.equal(isConversationActive(value), true);
});

test("passive interruption preserves name-soft origin and optional reply", async () => {
    const group = randomUUID();
    const name = message(group, "小尘，干他");
    const passive = message(group, "他竟然能够串联两个群吗？");
    commit(name);
    const { bot, calls } = fakeBot();
    const attempts: RecordedAttempt[] = [];
    const first = coordinateAiReply(requestFor(bot, name, 2), { executeAi: controlledAttempts(attempts) });
    await waitFor(() => attempts.length === 1);
    commit(passive);
    coordinateAiReply(requestFor(bot, passive, 0));
    await waitFor(() => attempts.length === 2);
    assert.equal(attempts[0].signal.aborted, true);
    assert.match(attempts[1].input, /小尘，干他/);
    assert.match(attempts[1].input, /他竟然能够串联两个群吗/);
    assert.match(attempts[1].input, /allowNoReply=true\norigin=name-soft effective=name-soft/);
    attempts[1].resolve({ kind: "no_reply" });
    await first;
    assert.equal(calls.length, 0);
    assert.equal(isConversationActive(name), false);
});

test("active-soft upgrades to name-soft and never downgrades on passive interruption", async () => {
    const group = randomUUID();
    const active = message(group, "普通后续");
    const name = message(group, "小尘你看看");
    const passive = message(group, "补充一句");
    markConversationActive(active);
    commit(active);
    const { bot } = fakeBot();
    const attempts: RecordedAttempt[] = [];
    const first = coordinateAiReply(requestFor(bot, active, 1), { executeAi: controlledAttempts(attempts) });
    await waitFor(() => attempts.length === 1);
    commit(name);
    coordinateAiReply(requestFor(bot, name, 2));
    await waitFor(() => attempts.length === 2);
    commit(passive);
    coordinateAiReply(requestFor(bot, passive, 0));
    await waitFor(() => attempts.length === 3);
    assert.match(attempts[2].input, /allowNoReply=true\norigin=active-soft effective=name-soft/);
    attempts[2].resolve({ kind: "no_reply" });
    await first;
    assert.equal(isConversationActive(active), true);
});

test("name-soft upgrades to hard mention and passive interruption cannot relax it", async () => {
    const group = randomUUID();
    const name = message(group, "小尘你看看");
    const hard = message(group, "@小尘 你倒是说句话");
    const passive = message(group, "又补充了一句");
    commit(name);
    const { bot, calls } = fakeBot();
    const attempts: RecordedAttempt[] = [];
    const first = coordinateAiReply(requestFor(bot, name, 2), { executeAi: controlledAttempts(attempts) });
    await waitFor(() => attempts.length === 1);
    commit(hard);
    coordinateAiReply(requestFor(bot, hard, 3));
    await waitFor(() => attempts.length === 2);
    commit(passive);
    coordinateAiReply(requestFor(bot, passive, 0));
    await waitFor(() => attempts.length === 3);
    assert.match(attempts[2].input, /allowNoReply=false\norigin=name-soft effective=hard-mention/);
    assert.match(attempts[2].input, /当前更明确的参与邀请：user：@小尘 你倒是说句话/);
    attempts[0].resolve({ kind: "no_reply" });
    assert.equal(attempts[2].signal.aborted, false);
    attempts[2].resolve({ kind: "no_reply" });
    await first;
    assert.ok(calls.some((call) => call.content));
});

test("active-soft NO_REPLY does not clear a newer engagement generation", async () => {
    const value = message(randomUUID(), "普通后续");
    markConversationActive(value);
    commit(value);
    const { bot } = fakeBot();
    const attempts: RecordedAttempt[] = [];
    const pending = coordinateAiReply(requestFor(bot, value, 1), { executeAi: controlledAttempts(attempts) });
    await waitFor(() => attempts.length === 1);
    markConversationActive(value);
    attempts[0].resolve({ kind: "no_reply" });
    await pending;
    assert.equal(isConversationActive(value), true);
});

test("active-soft NO_REPLY ends only its own active engagement", async () => {
    const value = message(randomUUID(), "普通后续");
    markConversationActive(value);
    commit(value);
    const { bot, calls } = fakeBot();
    await coordinateAiReply(requestFor(bot, value, 1), { executeAi: async () => ({ kind: "no_reply" }) });
    assert.equal(calls.length, 0);
    assert.equal(isConversationActive(value), false);
});

test("name-soft NO_REPLY does not turn passive trailing messages into active-soft", async () => {
    const group = randomUUID();
    const values = ["小尘，干他", "B", "C", "D", "E"].map((content) => message(group, content));
    commit(values[0]);
    const { bot, calls } = fakeBot();
    const attempts: RecordedAttempt[] = [];
    const deps = { executeAi: controlledAttempts(attempts) };
    const first = coordinateAiReply(requestFor(bot, values[0], 2), deps);
    await waitFor(() => attempts.length === 1);
    for (let index = 1; index <= 3; index++) {
        commit(values[index]);
        coordinateAiReply(requestFor(bot, values[index], 0));
        await waitFor(() => attempts.length === index + 1);
    }
    commit(values[4]);
    coordinateAiReply(requestFor(bot, values[4], 0));
    attempts[3].resolve({ kind: "no_reply" });
    await first;
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(attempts.length, 4);
    assert.equal(calls.length, 0);
    assert.equal(isConversationActive(values[0]), false);
});

test("late NO_REPLY from an interrupted name attempt cannot suppress a hard mention", async () => {
    const group = randomUUID();
    const name = message(group, "小尘你看看");
    const hard = message(group, "@小尘 你倒是说句话");
    commit(name);
    const { bot, calls } = fakeBot();
    const attempts: RecordedAttempt[] = [];
    const first = coordinateAiReply(requestFor(bot, name, 2), { executeAi: async (input, options) =>
        await new Promise<AiResult>((resolve) => attempts.push({ input, signal: options.signal, resolve })) });
    await waitFor(() => attempts.length === 1);
    commit(hard);
    coordinateAiReply(requestFor(bot, hard, 3));
    assert.equal(attempts[0].signal.aborted, true);
    attempts[0].resolve({ kind: "no_reply" });
    await waitFor(() => attempts.length === 2);
    assert.match(attempts[1].input, /allowNoReply=false\norigin=name-soft effective=hard-mention/);
    assert.match(attempts[1].input, /本轮最初因这条消息开始考虑参与：user：小尘你看看/);
    assert.match(attempts[1].input, /当前更明确的参与邀请：user：@小尘 你倒是说句话/);
    assert.equal(calls.length, 0);
    attempts[1].resolve(reply("我在"));
    await first;
    assert.equal(calls.length, 1);
    assert.equal(isConversationActive(name), true);
});

test("active-soft restart identifies the original anchor and newer message with temporary refs", async () => {
    const group = randomUUID();
    const anchor = message(group, "zdjd？");
    const interruption = message(group, "？啥真的假的");
    markConversationActive(anchor);
    commit(anchor);
    const { bot, calls } = fakeBot();
    const attempts: RecordedAttempt[] = [];
    const buildAttempt = async (current: NormalizedQqMessage, context: AttemptBuildContext) => ({
        aiInput: buildReplyCycleContext(current) + "\nallowNoReply=" + context.allowNoReply,
        imageUrls: [], refs: new Map([["m1", anchor.id!], ["m2", interruption.id!]]),
    });
    const first = coordinateAiReply({ ...requestFor(bot, anchor, 1), buildAttempt },
        { executeAi: controlledAttempts(attempts) });
    await waitFor(() => attempts.length === 1);
    commit(interruption);
    coordinateAiReply({ ...requestFor(bot, interruption, 1), buildAttempt });
    await waitFor(() => attempts.length === 2);
    const input = attempts[1].input;
    assert.match(input, /本轮最初因这条消息开始考虑参与：\[m1\] user：zdjd？/);
    assert.match(input, /上次生成后新增的群聊内容：\n\[m2\] user：？啥真的假的/);
    assert.match(input, /allowNoReply=true/);
    assert.doesNotMatch(input, new RegExp(anchor.id!));
    assert.doesNotMatch(input, new RegExp(interruption.id!));
    attempts[1].resolve({ kind: "no_reply" });
    await first;
    assert.equal(calls.length, 0);
});

test("three ordinary interruptions keep the first semantic anchor", async () => {
    const group = randomUUID();
    const values = ["zdjd？", "B", "C", "D"].map((content) => message(group, content));
    markConversationActive(values[0]);
    commit(values[0]);
    const { bot } = fakeBot();
    const attempts: RecordedAttempt[] = [];
    const first = coordinateAiReply(requestFor(bot, values[0], 1), { executeAi: controlledAttempts(attempts) });
    await waitFor(() => attempts.length === 1);
    for (let index = 1; index <= 3; index++) {
        commit(values[index]);
        coordinateAiReply(requestFor(bot, values[index], 1));
        await waitFor(() => attempts.length === index + 1);
        assert.match(attempts[index].input, /本轮最初因这条消息开始考虑参与：user：zdjd？/);
        assert.match(attempts[index].input, new RegExp(`上次生成后新增的群聊内容：\\nuser：${values[index].displayContent}`));
    }
    attempts[3].resolve({ kind: "no_reply" });
    await first;
});

test("name-soft upgrade replaces the effective anchor but keeps optional reply", async () => {
    const group = randomUUID();
    const original = message(group, "普通后续");
    const name = message(group, "小尘你看看这个");
    markConversationActive(original);
    commit(original);
    const { bot } = fakeBot();
    const attempts: RecordedAttempt[] = [];
    const first = coordinateAiReply(requestFor(bot, original, 1), { executeAi: controlledAttempts(attempts) });
    await waitFor(() => attempts.length === 1);
    commit(name);
    coordinateAiReply(requestFor(bot, name, 2));
    await waitFor(() => attempts.length === 2);
    assert.match(attempts[1].input, /本轮最初因这条消息开始考虑参与：user：普通后续/);
    assert.match(attempts[1].input, /当前更明确的参与邀请：user：小尘你看看这个/);
    assert.match(attempts[1].input, /allowNoReply=true/);
    attempts[1].resolve({ kind: "no_reply" });
    await first;
});

test("same-level explicit name trigger replaces the effective anchor", async () => {
    const group = randomUUID();
    const firstName = message(group, "小尘你看看");
    const secondName = message(group, "小尘，我说的是这个");
    commit(firstName);
    const { bot } = fakeBot();
    const attempts: RecordedAttempt[] = [];
    const first = coordinateAiReply(requestFor(bot, firstName, 2), { executeAi: controlledAttempts(attempts) });
    await waitFor(() => attempts.length === 1);
    commit(secondName);
    coordinateAiReply(requestFor(bot, secondName, 2));
    await waitFor(() => attempts.length === 2);
    assert.match(attempts[1].input, /本轮最初因这条消息开始考虑参与：user：小尘你看看/);
    assert.match(attempts[1].input, /当前更明确的参与邀请：user：小尘，我说的是这个/);
    attempts[1].resolve({ kind: "no_reply" });
    await first;
});

test("same-level hard mention replaces the effective anchor without changing the origin", async () => {
    const group = randomUUID();
    const firstHard = message(group, "@小尘 看这里");
    const secondHard = message(group, "@小尘 我说后面这个");
    commit(firstHard);
    const { bot } = fakeBot();
    const attempts: RecordedAttempt[] = [];
    const first = coordinateAiReply(requestFor(bot, firstHard, 3), { executeAi: controlledAttempts(attempts) });
    await waitFor(() => attempts.length === 1);
    commit(secondHard);
    coordinateAiReply(requestFor(bot, secondHard, 3));
    await waitFor(() => attempts.length === 2);
    assert.match(attempts[1].input, /本轮最初因这条消息开始考虑参与：user：@小尘 看这里/);
    assert.match(attempts[1].input, /当前更明确的参与邀请：user：@小尘 我说后面这个/);
    assert.match(attempts[1].input, /allowNoReply=false/);
    attempts[1].resolve(reply("看到了"));
    await first;
});

test("Meme retrieval on restart considers the anchor and only newer valid messages", async () => {
    const group = randomUUID();
    const anchor = message(group, "kskbl？");
    const unrelated = message(group, "今天天气普通");
    markConversationActive(anchor);
    commit(anchor);
    const { bot } = fakeBot();
    const attempts: RecordedAttempt[] = [];
    const queries: string[] = [];
    const memeContexts: string[] = [];
    const buildAttempt = async (current: NormalizedQqMessage, context: AttemptBuildContext) => {
        const query = buildReplyCycleMemeQuery(context);
        queries.push(query);
        memeContexts.push(buildAutoMemeContext(query));
        return { aiInput: buildReplyCycleContext(current), imageUrls: [] };
    };
    const first = coordinateAiReply({ ...requestFor(bot, anchor, 1), buildAttempt },
        { executeAi: controlledAttempts(attempts) });
    await waitFor(() => attempts.length === 1);
    commit(unrelated);
    coordinateAiReply({ ...requestFor(bot, unrelated, 1), buildAttempt });
    await waitFor(() => attempts.length === 2);
    assert.equal(queries[0], "kskbl？");
    assert.equal(queries[1], "kskbl？\n今天天气普通");
    assert.match(memeContexts[1], /name: kskbl\nconfidence: STRONG/);
    attempts[1].resolve({ kind: "no_reply" });
    await first;
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
    const recent = attempts[1].input.match(/<recent_context>([\s\S]*?)<\/recent_context>/)?.[1] ?? "";
    assert.equal((recent.match(/B adds context/g) ?? []).length, 1);
    assert.match(attempts[1].input, /上次生成后新增的群聊内容：\nuser：B adds context/);
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
    for (const text of ["E", "F", "G"]) assert.doesNotMatch(attempts[3].input, new RegExp(`user：${text}`));
    attempts[3].resolve(reply("cycle one"));
    await waitFor(() => attempts.length === 5);
    assert.equal(attempts[4].signal.aborted, false);
    for (const text of ["E", "F", "G"]) assert.match(attempts[4].input, new RegExp(text));
    assert.match(attempts[4].input, /allowNoReply=true/);
    const nextAnchor = attempts[4].input.match(/<reply_cycle_context>([\s\S]*?)<\/reply_cycle_context>/)?.[1] ?? "";
    assert.match(nextAnchor, /本轮最初因这条消息开始考虑参与：user：E/);
    assert.match(nextAnchor, /上次生成后新增的群聊内容：\nuser：F\nuser：G/);
    assert.doesNotMatch(nextAnchor, /user：A/);

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

test("NO_REPLY consumes only its snapshot and a trailing name trigger gets a new cycle", async () => {
    const group = randomUUID();
    const values = ["A", "B", "C", "D", "小尘 E", "F"].map((text) => message(group, text));
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
    coordinateAiReply(requestFor(bot, values[4], 2), deps);
    attempts[3].resolve({ kind: "no_reply" });
    await waitFor(() => attempts.length === 5);
    assert.match(attempts[4].input, /E/);
    assert.match(attempts[4].input, /origin=name-soft effective=name-soft/);
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
