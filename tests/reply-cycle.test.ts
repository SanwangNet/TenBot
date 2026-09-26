import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { QQBot } from "@tencent-connect/qqbot-nodejs";
import type { AiResult } from "../src/ai/reply-result.js";
import type { ModelPlugin } from "../src/ai/model-plugin.js";
import { ModelProviderError } from "../src/ai/model-plugin.js";
import type { AttemptRuntimeSnapshot } from "../src/ai/attempt-snapshot.js";
import { ToolProtocolLeakError } from "../src/ai/tool-protocol.js";
import { buildAutoMemeContext } from "../src/skills/meme/skill.js";
import { buildReplyCycleContext, recordIncomingMessageRevision, rememberIncomingMessage } from "../src/qq/conversation/recent-context.js";
import { getConversationGeneration, isConversationActive, markConversationActive } from "../src/qq/conversation/engagement.js";
import type { NormalizedQqMessage } from "../src/qq/message/normalize-message.js";
import { decideMessageTrigger } from "../src/qq/message/trigger.js";
import { buildReplyCycleMemeQuery, coordinateAiReply, subscribeReplyLifecycle, type AttemptBuildContext } from "../src/qq/reply/coordinator.js";

const MODEL_TIMEOUT_CODE = "M:A_MG_MTO";
const MODEL_TIMEOUT_MESSAGE = `ERROR: ${MODEL_TIMEOUT_CODE}`;

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
    const unrelated = message(group, "雪山救狐狸");
    markConversationActive(anchor);
    commit(anchor);
    const { bot } = fakeBot();
    const attempts: RecordedAttempt[] = [];
    const queries: string[] = [];
    const memeContexts: string[] = [];
    const buildAttempt = async (current: NormalizedQqMessage, context: AttemptBuildContext) => {
        const query = buildReplyCycleMemeQuery(context);
        queries.push(query);
        const memeQueries = [
            { text: context.effectiveAnchor.message.displayContent, source: "anchor" as const },
            ...context.newerMessages
                .filter((item) => item.revision !== context.effectiveAnchor.revision)
                .map((item) => ({ text: item.message.displayContent, source: "new-message" as const })),
        ];
        memeContexts.push(buildAutoMemeContext(memeQueries));
        return { aiInput: buildReplyCycleContext(current), imageUrls: [] };
    };
    const first = coordinateAiReply({ ...requestFor(bot, anchor, 1), buildAttempt },
        { executeAi: controlledAttempts(attempts) });
    await waitFor(() => attempts.length === 1);
    commit(unrelated);
    coordinateAiReply({ ...requestFor(bot, unrelated, 1), buildAttempt });
    await waitFor(() => attempts.length === 2);
    assert.equal(queries[0], "kskbl？");
    assert.equal(queries[1], "kskbl？\n雪山救狐狸");
    assert.match(memeContexts[1], /候选 1: kskbl\n匹配强度: strong/);
    assert.match(memeContexts[1], /雪山救狐狸/);
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

test("each restarted attempt gets an ordinary deadline, while timeout retry stays limited to one", async () => {
    const group = randomUUID();
    const a = message(group, "question");
    const b = message(group, "more");
    commit(a);
    const { bot, calls } = fakeBot();
    const attempts: RecordedAttempt[] = [];
    const started = Date.now();
    const pending = coordinateAiReply(requestFor(bot, a), {
        executeAi: controlledAttempts(attempts), timeoutMs: 55,
    });
    await waitFor(() => attempts.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 35));
    commit(b);
    coordinateAiReply(requestFor(bot, b, 0));
    await waitFor(() => attempts.length === 3);
    await pending;
    const elapsed = Date.now() - started;
    assert.equal(attempts[1].signal.aborted, true);
    assert.equal(attempts[2].signal.aborted, true);
    assert.ok(elapsed >= 90 && elapsed < 350, "the post-interruption timeout retry gets its own ordinary deadline");
    assert.ok(calls.some((call) => call.content === MODEL_TIMEOUT_MESSAGE || (call.payload as any)?.markdown?.content === MODEL_TIMEOUT_MESSAGE));
});

test("Reply Coordinator runs a ModelPlugin stub without constructing a provider client", async () => {
    const value = message(randomUUID(), "stub plugin");
    commit(value);
    const { bot, calls } = fakeBot();
    let names: string[] = [];
    const plugin: ModelPlugin = {
        id: "offline-stub",
        model: "stub-model",
        capabilities: { webSearch: false },
        async generate(request) {
            names = request.tools.map((tool) => tool.name);
            return reply("plugin result");
        },
    };
    await coordinateAiReply(requestFor(bot, value), { modelPlugin: plugin, multiMessageDelayMs: 0 });
    assert.deepEqual(names, ["qq_reply", "meme_lookup"]);
    assert.equal(calls.some((call) => call.content === "plugin result" || (call.payload as any)?.markdown?.content === "plugin result"), true);
});

test("ordinary timeout retries once with a fresh snapshot and keeps engagement and anchor", async () => {
    const value = message(randomUUID(), "active conversation");
    commit(value);
    markConversationActive(value);
    const generation = getConversationGeneration(value);
    const { bot, calls } = fakeBot();
    const attempts: RecordedAttempt[] = [];
    const refMaps: Map<string, string>[] = [];
    const anchorIds: string[][] = [];
    const request = requestFor(bot, value, 1);
    request.buildAttempt = async (_current, context) => {
        const refs = new Map([["m1", "real-m1"]]);
        refMaps.push(refs);
        anchorIds.push([context.originAnchor.message.id!, context.effectiveAnchor.message.id!]);
        return { aiInput: buildReplyCycleContext(value), imageUrls: [], refs };
    };
    let finishSecond!: (result: AiResult) => void;
    const pending = coordinateAiReply(request, {
        timeoutMs: 100,
        executeAi: async (input, options) => {
            attempts.push({ input, signal: options.signal, resolve: () => {} });
            if (attempts.length === 1) return await new Promise<AiResult>(() => {});
            return await new Promise<AiResult>((resolve) => { finishSecond = resolve; });
        },
    });
    await waitFor(() => attempts.length === 2);
    assert.equal(attempts[0].signal.aborted, true);
    assert.equal(attempts[1].signal.aborted, false);
    assert.equal(refMaps.length, 2);
    assert.notStrictEqual(refMaps[0], refMaps[1]);
    assert.deepEqual(anchorIds, [[value.id, value.id], [value.id, value.id]]);
    assert.equal(isConversationActive(value), true);
    assert.equal(getConversationGeneration(value), generation);
    assert.equal(calls.length, 0);
    finishSecond(reply("recovered"));
    await pending;
    assert.equal(calls.length, 1);
    assert.equal(calls[0].content, "recovered");
});

test("terminal confirmed model-provider 5xx sends one public error and stops the captured active generation", async () => {
    for (const [status, code] of [[500, "R:A_MP_PIE"], [503, "R:A_MP_PSU"]] as const) {
        const value = message(randomUUID(), `provider ${status}`);
        commit(value);
        markConversationActive(value);
        const { bot, calls } = fakeBot();
        let attempts = 0;
        await coordinateAiReply(requestFor(bot, value, 1), {
            executeAi: async () => {
                attempts++;
                throw new ModelProviderError("gpt", Object.assign(new Error("provider unavailable"), { status, retryable: true }));
            },
        });
        const publicMessages = calls.map((call) => call.content ?? (call.payload as { markdown?: { content?: string } } | undefined)?.markdown?.content)
            .filter((content): content is string => typeof content === "string" && content.startsWith("ERROR:"));
        assert.equal(attempts, 1);
        assert.deepEqual(publicMessages, [`ERROR: ${code}`]);
        assert.equal(calls.some((call) => call.content === code), false);
        assert.equal(calls.some((call) => call.content === "后端暂时炸了"), false);
        assert.equal(isConversationActive(value), false);
    }
});

test("terminal provider failure also ends active engagement during a hard mention, even when the notice send fails", async () => {
    const value = message(randomUUID(), "@小尘回来");
    commit(value);
    markConversationActive(value);
    const { bot } = fakeBot();
    (bot as any).send = async () => { throw Object.assign(new Error("QQ send failed"), { status: 503 }); };
    await coordinateAiReply(requestFor(bot, value, 3, false), {
        executeAi: async () => { throw new ModelProviderError("gpt", Object.assign(new Error("provider unavailable"), { status: 503, retryable: true })); },
    });
    assert.equal(isConversationActive(value), false);
});

test("provider 5xx generation guard keeps a newer active generation intact", async () => {
    const value = message(randomUUID(), "active generation");
    commit(value);
    markConversationActive(value);
    const oldGeneration = getConversationGeneration(value);
    const { bot } = fakeBot();
    let reject!: (error: unknown) => void;
    const pending = coordinateAiReply(requestFor(bot, value, 1), {
        executeAi: async () => await new Promise<AiResult>((_resolve, rejectAttempt) => { reject = rejectAttempt; }),
    });
    await waitFor(() => Boolean(reject));
    markConversationActive(value);
    const newGeneration = getConversationGeneration(value);
    assert.notEqual(newGeneration, oldGeneration);
    reject(new ModelProviderError("gpt", Object.assign(new Error("provider unavailable"), { status: 503, retryable: true })));
    await pending;
    assert.equal(isConversationActive(value), true);
    assert.equal(getConversationGeneration(value), newGeneration);
});

test("local model and QQ transport failures do not stop active engagement", async () => {
    const local = message(randomUUID(), "local failure");
    commit(local);
    markConversationActive(local);
    const { bot: localBot } = fakeBot();
    await coordinateAiReply(requestFor(localBot, local, 1), {
        executeAi: async () => { throw Object.assign(new Error("socket reset"), { code: "ECONNRESET" }); },
    });
    assert.equal(isConversationActive(local), true);

    const send = message(randomUUID(), "send failure");
    commit(send);
    markConversationActive(send);
    const { bot: sendBot } = fakeBot();
    (sendBot as any).sendMarkdown = async () => { throw Object.assign(new Error("QQ send failed"), { status: 503 }); };
    await coordinateAiReply(requestFor(sendBot, send), { executeAi: async () => reply("valid reply") });
    assert.equal(isConversationActive(send), true);
});

test("timeout retry does not consume revision or interruption budget", async () => {
    const group = randomUUID();
    const values = ["A", "B", "C", "D", "E"].map((text) => message(group, text));
    commit(values[0]);
    const { bot } = fakeBot();
    const attempts: RecordedAttempt[] = [];
    const pending = coordinateAiReply(requestFor(bot, values[0], 1), {
        timeoutMs: 15,
        executeAi: async (input, options) => {
            return await new Promise<AiResult>((resolve, reject) => {
                attempts.push({ input, signal: options.signal, resolve });
                options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
            });
        },
    });
    await waitFor(() => attempts.length === 2); // Attempt 1 timed out; Attempt 2 is its retry.
    for (const index of [1, 2, 3]) {
        commit(values[index]);
        coordinateAiReply(requestFor(bot, values[index], 0));
        await waitFor(() => attempts.length === index + 2);
    }
    assert.equal(attempts.length, 5); // Timeout retry plus all three interruption restarts.
    assert.deepEqual(attempts.slice(0, 4).map((attempt) => attempt.signal.aborted), [true, true, true, true]);
    commit(values[4]);
    coordinateAiReply(requestFor(bot, values[4], 0));
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(attempts.length, 5); // Fourth new message trails after the separate interrupt budget is spent.
    // Settle the current request so this test does not leave an active Cycle behind.
    attempts[4].resolve({ kind: "no_reply" });
    await pending;
});

test("second timeout keeps soft silence and hard fallback", async () => {
    for (const [priority, expectedFallback] of [[1, false], [3, true]] as const) {
        const value = message(randomUUID(), "stalled");
        commit(value);
        const { bot, calls } = fakeBot();
        let attempts = 0;
        await coordinateAiReply(requestFor(bot, value, priority), {
            timeoutMs: 12,
            executeAi: async () => {
                attempts++;
                return await new Promise<AiResult>(() => {});
            },
        });
        assert.equal(attempts, 2);
        assert.equal(calls.some((call) => call.content === MODEL_TIMEOUT_MESSAGE ||
            (call.payload as any)?.markdown?.content === MODEL_TIMEOUT_MESSAGE), expectedFallback);
    }
});

test("a newer revision skips timeout retry", async () => {
    const group = randomUUID();
    const a = message(group, "A");
    const b = message(group, "B");
    commit(a);
    const { bot, calls } = fakeBot();
    let attempts = 0;
    const pending = coordinateAiReply(requestFor(bot, a), {
        timeoutMs: 15,
        executeAi: async () => {
            attempts++;
            return await new Promise<AiResult>(() => {});
        },
    });
    await waitFor(() => attempts === 1);
    commit(b); // This revision reaches context before its handler updates the Cycle.
    await pending;
    assert.equal(attempts, 1);
    assert.ok(calls.some((call) => call.content === MODEL_TIMEOUT_MESSAGE ||
        (call.payload as any)?.markdown?.content === MODEL_TIMEOUT_MESSAGE));
});

test("web-search timeout does not retry and keeps the search timeout fallback", async () => {
    const value = message(randomUUID(), "search");
    commit(value);
    const { bot, calls } = fakeBot();
    let attempts = 0;
    await coordinateAiReply(requestFor(bot, value), {
        timeoutMs: 15,
        webSearchTimeoutMs: 45,
        executeAi: async (_input, options) => {
            attempts++;
            await options.onWebSearchStart?.();
            return await new Promise<AiResult>(() => {});
        },
    });
    assert.equal(attempts, 1);
    assert.ok(calls.some((call) => call.content === MODEL_TIMEOUT_MESSAGE ||
        (call.payload as any)?.markdown?.content === MODEL_TIMEOUT_MESSAGE));
});

test("late result from timed-out Attempt cannot replace the successful retry", async () => {
    const value = message(randomUUID(), "stale result");
    commit(value);
    const { bot, calls } = fakeBot();
    let resolveFirst!: (result: AiResult) => void;
    let attempts = 0;
    const pending = coordinateAiReply(requestFor(bot, value), {
        timeoutMs: 15,
        executeAi: async () => {
            attempts++;
            if (attempts === 1) return await new Promise<AiResult>((resolve) => { resolveFirst = resolve; });
            return reply("retry result");
        },
    });
    await pending;
    resolveFirst(reply("stale result"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(attempts, 2);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].content, "retry result");
});

test("a new Cycle gets its own timeout retry", async () => {
    const group = randomUUID();
    const a = message(group, "first Cycle");
    const b = message(group, "second Cycle");
    commit(a);
    const { bot, calls } = fakeBot();
    let attempts = 0;
    const deps = {
        timeoutMs: 12,
        executeAi: async (): Promise<AiResult> => {
            attempts++;
            return await new Promise<AiResult>(() => {});
        },
    };
    await coordinateAiReply(requestFor(bot, a), deps);
    commit(b);
    await coordinateAiReply(requestFor(bot, b), deps);
    assert.equal(attempts, 4);
    assert.equal(calls.filter((call) => call.content === MODEL_TIMEOUT_MESSAGE ||
        (call.payload as any)?.markdown?.content === MODEL_TIMEOUT_MESSAGE).length, 2);
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
    assert.equal(calls.filter((item) => item.content === MODEL_TIMEOUT_MESSAGE).length, 0);
    await pending;
    assert.equal(attempts[1].signal.aborted, true);
    assert.deepEqual(calls.map((item) => item.content ?? (item.payload as any)?.markdown?.content).filter(Boolean), ["search notice", MODEL_TIMEOUT_MESSAGE]);
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

test("protocol leakage is bounded and never sent to QQ as reply text", async () => {
    const value = message(randomUUID(), "protocol guard");
    commit(value);
    const { bot, calls } = fakeBot();
    const leaked = '<qq_reply><messages/></qq_reply>';
    let generations = 0;
    const plugin: ModelPlugin = {
        id: "deepseek", model: "offline", capabilities: { webSearch: false },
        async generate() {
            generations++;
            throw new ToolProtocolLeakError();
        },
    };
    await coordinateAiReply(requestFor(bot, value), { modelPlugin: plugin, multiMessageDelayMs: 0 });
    assert.equal(generations, 2, "only one protocol recovery generation is allowed");
    assert.ok(calls.length <= 1);
    assert.equal(calls.some((call) => call.content?.includes(leaked) || JSON.stringify(call.payload)?.includes(leaked)), false);
});

test("restarted soft Attempts retain complete context and keep NO_REPLY optional through Attempt #4", async () => {
    const group = randomUUID();
    const values = ["m1 原始问题", "m2 补充背景", "m3 群友插话", "m4 继续讨论", "m5 后续消息"]
        .map((text) => message(group, text));
    markConversationActive(values[0]!);
    commit(values[0]!);
    const { bot } = fakeBot();
    const attempts: RecordedAttempt[] = [];
    const contexts: AttemptBuildContext[] = [];
    const request = (index: number) => {
        const next = requestFor(bot, values[index]!, index === 0 ? 1 : 0, true);
        next.buildAttempt = async (current, context) => {
            contexts.push({ ...context, newerMessages: [...context.newerMessages] });
            return { aiInput: buildReplyCycleContext(current), imageUrls: [] };
        };
        return next;
    };
    const pending = coordinateAiReply(request(0), { executeAi: controlledAttempts(attempts) });
    await waitFor(() => attempts.length === 1);

    for (let index = 1; index <= 3; index++) {
        commit(values[index]!);
        coordinateAiReply(request(index));
        await waitFor(() => attempts.length === index + 1);
    }

    assert.equal(attempts.length, 4);
    assert.equal(contexts[3]?.snapshotRevision, 4);
    assert.equal(contexts[3]?.originAnchor.revision, 1);
    assert.equal(contexts[3]?.effectiveAnchor.revision, 1);
    assert.equal(contexts[3]?.effectiveTriggerKind, "active-soft");
    assert.equal(contexts[3]?.allowNoReply, true);
    assert.deepEqual(contexts[3]?.newerMessages.map((item) => item.revision), [4]);
    for (const text of values.slice(0, 4).map((item) => item.displayContent)) assert.match(attempts[3]!.input, new RegExp(text));

    commit(values[4]!);
    coordinateAiReply(request(4));
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(attempts[3]!.signal.aborted, false, "Attempt #4 is not interrupted after the budget is spent");
    assert.equal(attempts.length, 4);
    attempts[3]!.resolve({ kind: "no_reply" });
    await pending;
    assert.equal(attempts.length, 4, "a soft Attempt #4 may still choose NO_REPLY");
    for (const value of values) assert.match(buildReplyCycleContext(values[4]!), new RegExp(value.displayContent));
});

test("a hard mention upgrades soft obligation across later interruptions without downgrade", async () => {
    const group = randomUUID();
    const values = ["m1 active", "m2 ordinary", "@小尘 m3 hard", "m4 ordinary"]
        .map((text) => message(group, text));
    markConversationActive(values[0]!);
    commit(values[0]!);
    const { bot } = fakeBot();
    const attempts: RecordedAttempt[] = [];
    const contexts: AttemptBuildContext[] = [];
    const request = (index: number) => {
        const priority = index === 0 ? 1 : index === 2 ? 3 : 0;
        const next = requestFor(bot, values[index]!, priority, index !== 2);
        next.buildAttempt = async (current, context) => {
            contexts.push({ ...context, newerMessages: [...context.newerMessages] });
            return { aiInput: buildReplyCycleContext(current), imageUrls: [] };
        };
        return next;
    };
    const pending = coordinateAiReply(request(0), { executeAi: controlledAttempts(attempts) });
    await waitFor(() => attempts.length === 1);
    for (let index = 1; index <= 3; index++) {
        commit(values[index]!);
        coordinateAiReply(request(index));
        await waitFor(() => attempts.length === index + 1);
    }
    assert.deepEqual(contexts.map((context) => context.allowNoReply), [true, true, false, false]);
    assert.equal(contexts[3]?.originAnchor.revision, 1);
    assert.equal(contexts[3]?.effectiveAnchor.revision, 3);
    assert.equal(contexts[3]?.effectiveTriggerKind, "hard-mention");
    attempts[3]!.resolve({ kind: "no_reply" });
    await pending;
});

test("each Attempt captures one immutable model and Prompt snapshot", async () => {
    const group = randomUUID();
    const firstMessage = message(group, "active question");
    const interruptMessage = message(group, "newer context");
    markConversationActive(firstMessage);
    commit(firstMessage);
    const { bot } = fakeBot();
    const requests: Array<{ provider: string; model: string; systemPrompt: string; signal: AbortSignal }> = [];
    let rejectFirst!: (error: Error) => void;
    const gpt: ModelPlugin = {
        id: "gpt", model: "gpt-old", capabilities: { webSearch: false },
        async generate(request, options) {
            requests.push({ provider: this.id, model: this.model, systemPrompt: request.systemPrompt, signal: options.signal });
            return await new Promise<AiResult>((resolve, reject) => {
                rejectFirst = reject;
                options.signal.addEventListener("abort", () => reject(new Error("interrupted")), { once: true });
            });
        },
    };
    const deepseek: ModelPlugin = {
        id: "deepseek", model: "deepseek-new", capabilities: { webSearch: false },
        async generate(request, options) {
            requests.push({ provider: this.id, model: this.model, systemPrompt: request.systemPrompt, signal: options.signal });
            return { kind: "no_reply" };
        },
    };
    const snapshot = (model: ModelPlugin, revision: number, promptText: string, promptRevision: number): AttemptRuntimeSnapshot => ({
        model: { revision, provider: model.id, model, loadedAt: `model-${revision}` },
        prompt: { provider: model.id, content: promptText, revision: promptRevision, loadedAt: `prompt-${promptRevision}` },
    });
    let activeSnapshot = snapshot(gpt, 5, "PROMPT_A", 3);
    const pending = coordinateAiReply(requestFor(bot, firstMessage, 1), {
        captureAttemptSnapshot: () => activeSnapshot,
    });
    await waitFor(() => requests.length === 1);
    activeSnapshot = snapshot(deepseek, 6, "PROMPT_B", 8);
    commit(interruptMessage);
    coordinateAiReply(requestFor(bot, interruptMessage, 0));
    await waitFor(() => requests.length === 2);

    assert.deepEqual(requests.slice(0, 2).map(({ provider, model, systemPrompt }) => ({ provider, model, systemPrompt })), [
        { provider: "gpt", model: "gpt-old", systemPrompt: "PROMPT_A" },
        { provider: "deepseek", model: "deepseek-new", systemPrompt: "PROMPT_B" },
    ]);
    assert.equal(requests[0]?.signal.aborted, true);
    assert.equal(requests[1]?.signal.aborted, false);
    rejectFirst(new Error("settle old Attempt"));
    await pending;
});

test("conversation observer retains an interrupted Attempt and emits the replacement Attempt", async () => {
    const group = randomUUID();
    const firstMessage = message(group, "start");
    const nextMessage = message(group, "interrupt");
    commit(firstMessage);
    const { bot } = fakeBot();
    const attempts: RecordedAttempt[] = [];
    const events: Array<{ kind: string; attemptId: string }> = [];
    const unsubscribe = subscribeReplyLifecycle((signal) => events.push({ kind: signal.kind, attemptId: signal.attemptId }));
    try {
        const pending = coordinateAiReply(requestFor(bot, firstMessage), { executeAi: controlledAttempts(attempts) });
        await waitFor(() => attempts.length === 1);
        commit(nextMessage);
        coordinateAiReply(requestFor(bot, nextMessage, 0), { executeAi: controlledAttempts(attempts) });
        await waitFor(() => attempts.length === 2);
        attempts[1]?.resolve(reply("replacement"));
        await pending;
        assert.deepEqual(events.map((event) => event.kind), ["started", "interrupted", "started", "reply-sent", "completed"]);
        assert.equal(events[0]?.attemptId, events[1]?.attemptId, "interrupted lifecycle updates the same retained item");
        assert.notEqual(events[2]?.attemptId, events[0]?.attemptId);
    } finally {
        unsubscribe();
    }
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
    assert.ok(calls.some((call) => call.content === MODEL_TIMEOUT_MESSAGE ||
        (call.payload as any)?.markdown?.content === MODEL_TIMEOUT_MESSAGE));
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
