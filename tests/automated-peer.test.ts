import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { QQBot, QQBotInboundMessage } from "@tencent-connect/qqbot-nodejs";
import type { AiResult } from "../src/ai/reply-result.js";
import type { ModelPlugin } from "../src/ai/model-plugin.js";
import {
    BOT_LOOP_GUARD_NOTICE,
    createAutomatedPeerLoopGuard,
    DEFAULT_BOT_LOOP_GUARD_MAX_CYCLES,
    parseAutomatedPeerIds,
    parseBotLoopGuardMaxCycles,
} from "../src/qq/conversation/automated-peer.js";
import { buildChatInput, getMessageRevision, recordIncomingMessageRevision, rememberIncomingMessage } from "../src/qq/conversation/recent-context.js";
import { registerMessageHandler } from "../src/qq/handlers/message-handler.js";
import { normalizeQqMessage, type NormalizedQqMessage } from "../src/qq/message/normalize-message.js";
import { coordinateAiReply, type ReplyRequest } from "../src/qq/reply/coordinator.js";

interface SentMessage { method: "text" | "markdown"; content: string; target: unknown }

function fakeBot(sendGate?: () => Promise<void>) {
    const sent: SentMessage[] = [];
    let onMessage: ((context: unknown, message: QQBotInboundMessage) => Promise<void>) | undefined;
    const bot = {
        on(event: string, handler: (context: unknown, message: QQBotInboundMessage) => Promise<void>) {
            if (event === "message") onMessage = handler;
        },
        async sendText(target: unknown, content: string) {
            sent.push({ method: "text", target, content });
        },
        async sendMarkdown(target: unknown, content: string) {
            if (sendGate) await sendGate();
            sent.push({ method: "markdown", target, content });
        },
        async send(payload: { target?: unknown; markdown?: { content?: string } }) {
            sent.push({ method: "markdown", target: payload.target, content: payload.markdown?.content ?? "" });
        },
    } as unknown as QQBot;
    return { bot, sent, get onMessage() { return onMessage; } };
}

function message(groupId: string = randomUUID(), authorId = "human-1", content = "hello", authorName = "Member", authorIsBot = false): NormalizedQqMessage {
    return {
        source: {} as never, id: randomUUID(), kind: "group", eventType: "GROUP_MESSAGE_CREATE",
        content, displayContent: content, groupId, author: null, authorId, authorName, authorIsBot,
        mentions: [], attachments: [],
        replyTarget: { scope: "group", targetId: groupId, msgId: randomUUID() }, raw: {},
    } as NormalizedQqMessage;
}

function commit(value: NormalizedQqMessage): number {
    const revision = recordIncomingMessageRevision(value);
    rememberIncomingMessage(value, value.displayContent);
    return revision;
}

function requestFor(bot: QQBot, value: NormalizedQqMessage, hardMention = false): ReplyRequest {
    const revision = getMessageRevision(value);
    return {
        bot, message: value, aiInput: value.displayContent, imageUrls: [], isGroup: true,
        allowNoReply: !hardMention, triggerKind: hardMention ? "hard-mention" : "name-soft",
        triggerPriority: hardMention ? 3 : 2, isAtBot: hardMention, mentionedByName: !hardMention,
        messageRevision: revision, onWebSearchStart: () => {},
        buildAttempt: async (current) => ({ aiInput: current.displayContent, imageUrls: [] }),
    };
}

function plugin(generate: ModelPlugin["generate"]): ModelPlugin {
    return { id: "offline-test", model: "stub", capabilities: { webSearch: false }, generate };
}

function resultNoReply(): AiResult { return { kind: "no_reply" }; }
function resultThreeMessages(): AiResult {
    return {
        kind: "reply",
        action: {
            messages: ["one", "two", "three"].map((content) => ({
                content, quote: { mode: "none" as const, ref: null },
            })),
            mentions: [],
        },
    };
}

async function waitFor(check: () => boolean, timeoutMs = 1500): Promise<void> {
    const started = Date.now();
    while (!check()) {
        if (Date.now() - started > timeoutMs) throw new Error("condition timed out");
        await new Promise((resolve) => setTimeout(resolve, 2));
    }
}

function inboundMessage(groupId: string, authorId: string, content: string, options: {
    authorName?: string; bot?: boolean; attachments?: unknown[]; eventType?: string;
} = {}): QQBotInboundMessage {
    const authorName = options.authorName ?? "Member";
    return {
        kind: "group", rawEventType: options.eventType ?? "GROUP_MESSAGE_CREATE", messageId: randomUUID(),
        content, groupOpenid: groupId, senderId: authorId, senderName: authorName, senderIsBot: options.bot,
        timestamp: new Date().toISOString(),
        replyTarget: { scope: "group", targetId: groupId, msgId: randomUUID() },
        mentions: [], attachments: (options.attachments ?? []) as never[],
        raw: {
            group_openid: groupId,
            author: { member_openid: authorId, username: authorName, bot: options.bot },
            mentions: [],
        },
    } as unknown as QQBotInboundMessage;
}

test("registry matches only exact stable IDs and validates the default cycle limit", () => {
    assert.deepEqual([...parseAutomatedPeerIds(" A, B ,, ")], ["A", "B"]);
    assert.equal(DEFAULT_BOT_LOOP_GUARD_MAX_CYCLES, 4);
    assert.equal(parseBotLoopGuardMaxCycles(undefined), 4);
    assert.equal(parseBotLoopGuardMaxCycles("7"), 7);
    assert.throws(() => parseBotLoopGuardMaxCycles("0"));
    assert.throws(() => parseBotLoopGuardMaxCycles("four"));

    const guard = createAutomatedPeerLoopGuard("A,B");
    assert.equal(guard.isAutomatedPeer("A"), true);
    assert.equal(guard.isAutomatedPeer("B"), true);
    assert.equal(guard.isAutomatedPeer("C"), false);
    assert.equal(guard.isAutomatedPeer(undefined), false);
    // Different names cannot change an ID's registry membership; matching names cannot transfer it.
    const oldName = message("registry-test", "A", "hello", "小鲸鱼");
    const newName = message("registry-test", "A", "hello", "大鲸鱼");
    const sameNameHuman = message("registry-test", "H", "hello", "小鲸鱼");
    assert.equal(guard.isAutomatedPeer(oldName.authorId), true);
    assert.equal(guard.isAutomatedPeer(newName.authorId), true);
    assert.equal(guard.isAutomatedPeer(sameNameHuman.authorId), false);

    let currentTime = 0;
    const expiring = createAutomatedPeerLoopGuard("A", 1, () => currentTime, 10);
    assert.equal(expiring.beforeNewCycle("group:ttl", "A").allowed, true);
    assert.equal(expiring.beforeNewCycle("group:ttl", "A").allowed, false);
    currentTime = 10;
    assert.equal(expiring.beforeNewCycle("group:ttl", "A").cycle, 1);
});

test("group normalization prefers member_openid and fails open without a stable group ID", async () => {
    const raw = inboundMessage("group-normalize", "stable-member-A", "hello");
    (raw as unknown as { author: unknown }).author = { id: "display-or-unstable", member_openid: "stable-member-A" };
    const normalized = await normalizeQqMessage({}, raw);
    assert.equal(normalized.authorId, "stable-member-A");

    const { author: _author, ...withoutTopLevelAuthor } = raw as unknown as QQBotInboundMessage & { author: unknown };
    const missing = { ...withoutTopLevelAuthor, senderId: undefined, raw: { author: { id: "unstable-only" } } } as unknown as QQBotInboundMessage;
    const missingNormalized = await normalizeQqMessage({}, missing);
    assert.equal(missingNormalized.authorId, undefined);
});

test("four automated cycles count across peers, NO_REPLY and multi-message replies; lock notice is local and once", async () => {
    const groupId = "loop-group-main";
    const guard = createAutomatedPeerLoopGuard("peer-A,peer-B", 4);
    const { bot, sent } = fakeBot();
    let generateCalls = 0;
    const model = plugin(async (request) => {
        generateCalls++;
        assert.ok(!request.input.includes("peer-A"));
        assert.ok(!request.input.includes("peer-B"));
        return generateCalls === 1 ? resultThreeMessages() : resultNoReply();
    });

    for (const [index, peerId] of ["peer-A", "peer-B", "peer-A", "peer-B"].entries()) {
        const value = message(groupId, peerId, "automated turn " + index, "Peer " + index, true);
        commit(value);
        await coordinateAiReply(requestFor(bot, value), {
            modelPlugin: model, botLoopGuard: guard, multiMessageDelayMs: 0,
        });
    }
    assert.equal(generateCalls, 4);
    assert.equal(sent.filter((item) => item.method === "markdown").length, 3);

    const hardMention = message(groupId, "peer-A", "@小尘 please reply", "Peer A", true);
    commit(hardMention);
    await coordinateAiReply(requestFor(bot, hardMention, true), { modelPlugin: model, botLoopGuard: guard });
    assert.equal(generateCalls, 4, "locked hard mentions must not reach the model");
    const otherLockedMessage = message(groupId, "peer-B", "more", "Peer B", true);
    commit(otherLockedMessage);
    await coordinateAiReply(requestFor(bot, otherLockedMessage), { modelPlugin: model, botLoopGuard: guard });
    assert.equal(generateCalls, 4);

    const notices = sent.filter((item) => item.method === "text" && item.content === BOT_LOOP_GUARD_NOTICE);
    assert.equal(notices.length, 1);
    assert.deepEqual(notices[0].target, hardMention.replyTarget);
    assert.equal(sent.filter((item) => item.method === "text").length, 1,
        "the local notice is a plain sendText with no mention or quote payload");

    const otherGroupMessage = message("loop-group-other", "peer-A", "different conversation", "Peer A", true);
    commit(otherGroupMessage);
    await coordinateAiReply(requestFor(bot, otherGroupMessage), { modelPlugin: model, botLoopGuard: guard });
    assert.equal(generateCalls, 5, "one group's lock must not affect another group");

    guard.resetByHumanMessage(`group:${groupId}`, "Human");
    const humanHardMention = message(groupId, "human-A", "@小尘 answer", "Human");
    commit(humanHardMention);
    await coordinateAiReply(requestFor(bot, humanHardMention, true), { modelPlugin: model, botLoopGuard: guard });
    assert.equal(generateCalls, 6, "human hard mentions still reach the model after a reset");
    const resumed = message(groupId, "peer-B", "after human", "Peer B", true);
    commit(resumed);
    await coordinateAiReply(requestFor(bot, resumed), { modelPlugin: model, botLoopGuard: guard });
    assert.equal(generateCalls, 7, "human activity restores the cycle allowance");
    for (let index = 0; index < 3; index++) {
        const peer = message(groupId, "peer-A", "after reset " + index, "Peer A", true);
        commit(peer);
        await coordinateAiReply(requestFor(bot, peer), { modelPlugin: model, botLoopGuard: guard });
    }
    const relocked = message(groupId, "peer-B", "lock again", "Peer B", true);
    commit(relocked);
    await coordinateAiReply(requestFor(bot, relocked), { modelPlugin: model, botLoopGuard: guard });
    assert.equal(generateCalls, 10);
    assert.equal(sent.filter((item) => item.method === "text" && item.content === BOT_LOOP_GUARD_NOTICE).length, 2,
        "a human reset allows one new local notice at the next lock");
});

test("an automated interruption restarts the same human cycle without charging a peer cycle", async () => {
    const groupId = "loop-group-interrupt";
    const guard = createAutomatedPeerLoopGuard("peer-A", 1);
    const { bot, sent } = fakeBot();
    const attempts: Array<{ signal: AbortSignal; resolve: (value: AiResult) => void }> = [];
    const executeAi = async (_input: string, options: { signal: AbortSignal }): Promise<AiResult> =>
        await new Promise<AiResult>((resolve, reject) => {
            attempts.push({ signal: options.signal, resolve });
            const abort = () => reject(new Error("aborted"));
            if (options.signal.aborted) abort();
            else options.signal.addEventListener("abort", abort, { once: true });
        });

    const human = message(groupId, "human-A", "human question");
    commit(human);
    const humanCycle = coordinateAiReply(requestFor(bot, human), { executeAi, botLoopGuard: guard });
    await waitFor(() => attempts.length === 1);

    const interruption = message(groupId, "peer-A", "automated follow-up", "Peer A", true);
    commit(interruption);
    void coordinateAiReply(requestFor(bot, interruption), { executeAi, botLoopGuard: guard });
    await waitFor(() => attempts.length === 2);
    assert.equal(attempts[0].signal.aborted, true);
    attempts[1].resolve(resultNoReply());
    await humanCycle;

    const firstNewPeerCycle = message(groupId, "peer-A", "new cycle one", "Peer A", true);
    commit(firstNewPeerCycle);
    await coordinateAiReply(requestFor(bot, firstNewPeerCycle), { executeAi: async () => resultNoReply(), botLoopGuard: guard });
    assert.equal(sent.filter((item) => item.content === BOT_LOOP_GUARD_NOTICE).length, 0,
        "the interruption was part of the human-origin Cycle, so the first new peer cycle remains allowed");

    const secondNewPeerCycle = message(groupId, "peer-A", "new cycle two", "Peer A", true);
    commit(secondNewPeerCycle);
    await coordinateAiReply(requestFor(bot, secondNewPeerCycle), { executeAi: async () => resultNoReply(), botLoopGuard: guard });
    assert.equal(sent.filter((item) => item.content === BOT_LOOP_GUARD_NOTICE).length, 1);
});

test("trailing automated next Cycle is guarded before another model call", async () => {
    const groupId = "loop-group-trailing";
    const guard = createAutomatedPeerLoopGuard("peer-A", 1);
    const initialAuto = message(groupId, "peer-A", "first automated", "Peer A", true);
    commit(initialAuto);
    const { bot, sent } = fakeBot();
    let modelCalls = 0;
    await coordinateAiReply(requestFor(bot, initialAuto), {
        executeAi: async () => { modelCalls++; return resultNoReply(); }, botLoopGuard: guard,
    });

    let releaseSend!: () => void;
    let enteredSend!: () => void;
    const sendEntered = new Promise<void>((resolve) => { enteredSend = resolve; });
    const sendGate = new Promise<void>((resolve) => { releaseSend = resolve; });
    const gated = fakeBot(async () => { enteredSend(); await sendGate; });
    const human = message(groupId, "human-A", "human trigger");
    commit(human);
    const humanCycle = coordinateAiReply(requestFor(gated.bot, human), {
        executeAi: async () => { modelCalls++; return resultThreeMessages(); },
        botLoopGuard: guard, multiMessageDelayMs: 0,
    });
    await sendEntered;

    const trailing = message(groupId, "peer-A", "trailing bot mention", "Peer A", true);
    commit(trailing);
    void coordinateAiReply(requestFor(gated.bot, trailing, true), {
        executeAi: async () => { modelCalls++; return resultNoReply(); }, botLoopGuard: guard,
    });
    releaseSend();
    await humanCycle;
    await waitFor(() => sent.length > 0 || gated.sent.some((item) => item.content === BOT_LOOP_GUARD_NOTICE));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(modelCalls, 2, "the trailing Cycle must be blocked before invoking the model");
    assert.equal(gated.sent.filter((item) => item.content === BOT_LOOP_GUARD_NOTICE).length, 1);
});

test("human QQ face and image reset the guard before context filtering; commands still route while locked", async () => {
    const groupId = "loop-group-human-reset";
    const guard = createAutomatedPeerLoopGuard("peer-A", 1);
    const key = `group:${groupId}`;
    assert.equal(guard.beforeNewCycle(key, "peer-A", "Peer A").allowed, true);
    assert.equal(guard.beforeNewCycle(key, "peer-A", "Peer A").allowed, false);

    const fake = fakeBot();
    registerMessageHandler(fake.bot, guard);
    assert.ok(fake.onMessage);
    const face = inboundMessage(groupId, "human-A", "<faceType=13>", { authorName: "Human" });
    const normalizedFace = await normalizeQqMessage({}, face);
    await fake.onMessage({}, face);
    assert.equal(getMessageRevision(normalizedFace), 0, "human face resets state without incrementing Context revision");
    assert.doesNotMatch(buildChatInput(normalizedFace, ""), /faceType=13/);
    assert.equal(guard.beforeNewCycle(key, "peer-A", "Renamed peer").cycle, 1);

    // Lock again; an image-only human message resets before the normal image path.
    assert.equal(guard.beforeNewCycle(key, "peer-A", "Peer A").allowed, false);
    const image = inboundMessage(groupId, "human-A", "", {
        authorName: "Human", attachments: [{ content_type: "image/png", url: "https://invalid.test/image.png" }],
    });
    const normalizedImage = await normalizeQqMessage({}, image);
    await fake.onMessage({}, image);
    assert.equal(getMessageRevision(normalizedImage), 1, "image remains on its existing Context path");
    assert.equal(guard.beforeNewCycle(key, "peer-A", "Peer A").cycle, 1);

    // Lock again and prove commands are still local and not sent to a model.
    assert.equal(guard.beforeNewCycle(key, "peer-A", "Peer A").allowed, false);
    const help = inboundMessage(groupId, "peer-A", "/help", { authorName: "Peer A", bot: true });
    await fake.onMessage({}, help);
    assert.ok(fake.sent.some((item) => item.content.includes("/help")));

    // An unregistered SDK bot flag does not change the fail-open human path.
    const unknownBotGroup = "loop-group-unknown-bot";
    const unknownBot = inboundMessage(unknownBotGroup, "unregistered", "ordinary message", {
        authorName: "小鲸鱼", bot: true,
    });
    const normalizedUnknown = await normalizeQqMessage({}, unknownBot);
    await fake.onMessage({}, unknownBot);
    assert.equal(getMessageRevision(normalizedUnknown), 1);
});
