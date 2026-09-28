import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { QQBot, QQBotInboundMessage } from "@tencent-connect/qqbot-nodejs";
import type { AiResult } from "../src/ai/reply-result.js";
import { GroupRepeater } from "../src/front/repeater.js";
import { MemoryMemberRepository } from "../src/members/memory-repository.js";
import { configureMemberRepository } from "../src/qq/conversation/known-members.js";
import { buildChatInput } from "../src/qq/conversation/recent-context.js";
import { registerMessageHandler } from "../src/qq/handlers/message-handler.js";
import { normalizeQqMessage } from "../src/qq/message/normalize-message.js";
import type { FrontMode } from "../src/front/wake-level.js";
import { createAutomatedPeerLoopGuard } from "../src/qq/conversation/automated-peer.js";

test("repeater requires different senders and exact normalized text", () => {
    const repeater = new GroupRepeater();
    assert.deepEqual(repeater.observe({ groupId: "g", senderId: "a", content: "好事啊\r\n下一行" }), { repeat: false });
    assert.deepEqual(repeater.observe({ groupId: "g", senderId: "a", content: "好事啊\n下一行" }), { repeat: false });
    assert.deepEqual(repeater.observe({ groupId: "g", senderId: "b", content: "好事啊\n下一行" }), {
        repeat: true, content: "好事啊\n下一行",
    });

    for (const [left, right] of [
        ["好事啊", "好事啊！"],
        ["好事啊", " 好事啊"],
        ["OK", "ok"],
    ]) {
        const strict = new GroupRepeater();
        strict.observe({ groupId: "g", senderId: "a", content: left });
        assert.deepEqual(strict.observe({ groupId: "g", senderId: "b", content: right }), { repeat: false });
    }
});

test("repeater state is isolated per group and requires nonempty content", () => {
    const repeater = new GroupRepeater();
    assert.deepEqual(repeater.observe({ groupId: "g1", senderId: "a", content: "好事啊" }), { repeat: false });
    assert.deepEqual(repeater.observe({ groupId: "g2", senderId: "b", content: "好事啊" }), { repeat: false });
    assert.deepEqual(repeater.observe({ groupId: "g2", senderId: "c", content: "好事啊" }), {
        repeat: true, content: "好事啊",
    });
    assert.deepEqual(repeater.observe({ groupId: "g1", senderId: "b", content: "" }), { repeat: false });
    assert.deepEqual(repeater.observe({ groupId: "g1", senderId: "b", content: "好事啊" }), {
        repeat: true, content: "好事啊",
    });
});

test("active repeat suppresses repeats until different eligible text breaks the round", () => {
    const repeater = new GroupRepeater();
    repeater.observe({ groupId: "g", senderId: "a", content: "好事啊" });
    assert.deepEqual(repeater.observe({ groupId: "g", senderId: "b", content: "好事啊" }), {
        repeat: true, content: "好事啊",
    });
    assert.deepEqual(repeater.observe({ groupId: "g", senderId: "c", content: "好事啊" }), { repeat: false });
    assert.deepEqual(repeater.observe({ groupId: "g", senderId: "d", content: "确实" }), { repeat: false });
    repeater.observe({ groupId: "g", senderId: "e", content: "好事啊" });
    assert.deepEqual(repeater.observe({ groupId: "g", senderId: "f", content: "好事啊" }), {
        repeat: true, content: "好事啊",
    });
});

interface SentMessage {
    method: "text" | "markdown";
    content: string;
}

function fakeBot() {
    const sent: SentMessage[] = [];
    let onMessage: ((context: unknown, message: QQBotInboundMessage) => Promise<void>) | undefined;
    let responseId = 0;
    const response = () => ({ id: `bot-${++responseId}`, ext_info: { ref_idx: `bot-ref-${responseId}` } });
    const bot = {
        on(event: string, handler: (context: unknown, message: QQBotInboundMessage) => Promise<void>) {
            if (event === "message") onMessage = handler;
        },
        async sendText(_target: unknown, content: string) {
            sent.push({ method: "text", content });
            return response();
        },
        async sendMarkdown(_target: unknown, content: string) {
            sent.push({ method: "markdown", content });
            return response();
        },
        async send(payload: { markdown?: { content?: string } }) {
            sent.push({ method: "markdown", content: payload.markdown?.content ?? "" });
            return response();
        },
    } as unknown as QQBot;
    return { bot, sent, get onMessage() { return onMessage; } };
}

interface InboundOptions {
    groupId?: string;
    memberOpenid?: string;
    eventType?: string;
    bot?: boolean;
    authorIsYou?: boolean;
    attachments?: unknown[];
    mentions?: unknown[];
}

function inbound(content: string, options: InboundOptions = {}): QQBotInboundMessage {
    const groupId = options.groupId ?? "group-default";
    const memberOpenid = options.memberOpenid ?? randomUUID();
    const messageId = randomUUID();
    const mentions = options.mentions ?? [];
    return {
        kind: "group",
        rawEventType: options.eventType ?? "GROUP_MESSAGE_CREATE",
        messageId,
        msgIdx: `idx-${messageId}`,
        content,
        groupOpenid: groupId,
        senderId: `sdk-${memberOpenid}`,
        senderName: "群友",
        senderIsBot: options.bot,
        attachments: options.attachments ?? [],
        mentions: mentions as never[],
        replyTarget: { scope: "group", targetId: groupId, msgId: messageId },
        raw: {
            group_openid: groupId,
            author: { member_openid: memberOpenid, username: "群友", is_you: options.authorIsYou },
            mentions,
            attachments: options.attachments ?? [],
        },
    } as unknown as QQBotInboundMessage;
}

function reply(content: string): AiResult {
    return { kind: "reply", action: {
        messages: [{ content, quote: { mode: "none", ref: null } }], mentions: [],
    } };
}

function register(fake: ReturnType<typeof fakeBot>, options: {
    frontMode?: FrontMode;
    automatedPeerIds?: string[];
    judge?: () => Promise<{ decision: "pass" | "reply" }>;
    executeAi?: () => Promise<AiResult>;
} = {}) {
    let judgeCalls = 0;
    let mainCalls = 0;
    const cleanup = registerMessageHandler(
        fake.bot,
        createAutomatedPeerLoopGuard(options.automatedPeerIds ?? []),
        undefined,
        undefined,
        { async judge() { judgeCalls++; return options.judge ? options.judge() : { decision: "pass" }; } },
        { executeAi: async () => { mainCalls++; return options.executeAi ? options.executeAi() : reply("模型回复"); }, multiMessageDelayMs: 0 },
        () => options.frontMode ?? "legacy",
    );
    return { cleanup, get judgeCalls() { return judgeCalls; }, get mainCalls() { return mainCalls; } };
}

test("matching group text sends one standalone reply and records the successful bot message", async () => {
    configureMemberRepository(new MemoryMemberRepository());
    const fake = fakeBot();
    const runtime = register(fake, { frontMode: "judge" });
    const groupId = randomUUID();
    try {
        const first = inbound("好事啊", { groupId, memberOpenid: "member-a" });
        await fake.onMessage!({}, first);
        assert.equal(runtime.judgeCalls, 1, "the first ordinary message follows the configured Judge path");

        const second = inbound("好事啊", { groupId, memberOpenid: "member-b" });
        await fake.onMessage!({}, second);
        assert.equal(runtime.judgeCalls, 1, "the matching message bypasses Reply Judge");
        assert.equal(runtime.mainCalls, 0, "the matching message bypasses the Main Model and AI cycle");
        assert.deepEqual(fake.sent, [{ method: "text", content: "好事啊" }]);

        const normalized = await normalizeQqMessage({}, second);
        assert.match(buildChatInput(normalized, "下一条"), /小尘：好事啊/);

        await fake.onMessage!({}, inbound("好事啊", { groupId, memberOpenid: "member-c" }));
        assert.equal(fake.sent.filter((item) => item.method === "text").length, 1, "the same active repeat is not echoed again");
        assert.equal(runtime.mainCalls, 0);
    } finally {
        runtime.cleanup();
    }
});

test("only eligible group text changes repeater state", async () => {
    configureMemberRepository(new MemoryMemberRepository());
    const fake = fakeBot();
    const runtime = register(fake, {
        automatedPeerIds: ["automated-peer"],
        executeAi: async () => reply("direct reply"),
    });
    try {
        const mediaGroup = randomUUID();
        await fake.onMessage!({}, inbound("好事啊", { groupId: mediaGroup, memberOpenid: "a" }));
        await fake.onMessage!({}, inbound("", {
            groupId: mediaGroup, memberOpenid: "image-sender",
            attachments: [{ content_type: "image/png", url: "https://example.invalid/image.png" }],
        }));
        await fake.onMessage!({}, inbound("好事啊", { groupId: mediaGroup, memberOpenid: "b" }));

        const peerGroup = randomUUID();
        await fake.onMessage!({}, inbound("好事啊", { groupId: peerGroup, memberOpenid: "a" }));
        await fake.onMessage!({}, inbound("好事啊", { groupId: peerGroup, memberOpenid: "automated-peer" }));
        await fake.onMessage!({}, inbound("好事啊", { groupId: peerGroup, memberOpenid: "b" }));

        const botGroup = randomUUID();
        await fake.onMessage!({}, inbound("好事啊", { groupId: botGroup, memberOpenid: "a" }));
        await fake.onMessage!({}, inbound("好事啊", { groupId: botGroup, memberOpenid: "bot", bot: true }));
        await fake.onMessage!({}, inbound("好事啊", { groupId: botGroup, memberOpenid: "b" }));

        const stickerGroup = randomUUID();
        await fake.onMessage!({}, inbound("好事啊", { groupId: stickerGroup, memberOpenid: "a" }));
        await fake.onMessage!({}, inbound("<faceType=13>", { groupId: stickerGroup, memberOpenid: "sticker-sender" }));
        await fake.onMessage!({}, inbound("好事啊", { groupId: stickerGroup, memberOpenid: "b" }));

        const repeated = fake.sent.filter((item) => item.method === "text" && item.content === "好事啊");
        assert.equal(repeated.length, 4, "images, automated peers, bot messages, and stickers do not interrupt human text state");

        const echoesBeforeIgnoredFirst = repeated.length;
        const peerFirstGroup = randomUUID();
        await fake.onMessage!({}, inbound("好事啊", { groupId: peerFirstGroup, memberOpenid: "automated-peer" }));
        await fake.onMessage!({}, inbound("好事啊", { groupId: peerFirstGroup, memberOpenid: "human-a" }));
        assert.equal(fake.sent.filter((item) => item.method === "text" && item.content === "好事啊").length, echoesBeforeIgnoredFirst,
            "an automated peer cannot become the previous human candidate");
        await fake.onMessage!({}, inbound("好事啊", { groupId: peerFirstGroup, memberOpenid: "human-b" }));

        const botFirstGroup = randomUUID();
        await fake.onMessage!({}, inbound("好事啊", { groupId: botFirstGroup, memberOpenid: "bot", bot: true }));
        await fake.onMessage!({}, inbound("好事啊", { groupId: botFirstGroup, memberOpenid: "human-a" }));
        assert.equal(fake.sent.filter((item) => item.method === "text" && item.content === "好事啊").length, echoesBeforeIgnoredFirst + 1,
            "a bot's message cannot become the previous human candidate");
        await fake.onMessage!({}, inbound("好事啊", { groupId: botFirstGroup, memberOpenid: "human-b" }));
        assert.equal(fake.sent.filter((item) => item.method === "text" && item.content === "好事啊").length, echoesBeforeIgnoredFirst + 2);

        const selfFirstGroup = randomUUID();
        await fake.onMessage!({}, inbound("好事啊", { groupId: selfFirstGroup, memberOpenid: "self", authorIsYou: true }));
        await fake.onMessage!({}, inbound("好事啊", { groupId: selfFirstGroup, memberOpenid: "human-a" }));
        assert.equal(fake.sent.filter((item) => item.method === "text" && item.content === "好事啊").length, echoesBeforeIgnoredFirst + 2,
            "the QQ is_you identity cannot become the previous human candidate");
        await fake.onMessage!({}, inbound("好事啊", { groupId: selfFirstGroup, memberOpenid: "human-b" }));
        assert.equal(fake.sent.filter((item) => item.method === "text" && item.content === "好事啊").length, echoesBeforeIgnoredFirst + 3);
        assert.equal(runtime.mainCalls, 0);
    } finally {
        runtime.cleanup();
    }
});

test("commands and explicit Bot mentions neither trigger nor break active repeats", async () => {
    configureMemberRepository(new MemoryMemberRepository());
    const fake = fakeBot();
    const runtime = register(fake, {
        executeAi: async () => reply("direct reply"),
    });
    const groupId = randomUUID();
    try {
        await fake.onMessage!({}, inbound("好事啊", { groupId, memberOpenid: "a" }));
        await fake.onMessage!({}, inbound("好事啊", { groupId, memberOpenid: "b" }));
        assert.equal(fake.sent.filter((item) => item.method === "text" && item.content === "好事啊").length, 1);

        await fake.onMessage!({}, inbound("/添加表情 xxx", { groupId, memberOpenid: "c" }));
        await fake.onMessage!({}, inbound("/添加表情 xxx", { groupId, memberOpenid: "d" }));
        await fake.onMessage!({}, inbound("@小尘 好事啊", {
            groupId,
            memberOpenid: "e",
            eventType: "GROUP_AT_MESSAGE_CREATE",
            mentions: [{ is_you: true, username: "小尘" }],
        }));
        await fake.onMessage!({}, inbound("好事啊", { groupId, memberOpenid: "f" }));

        assert.equal(fake.sent.filter((item) => item.method === "text" && item.content === "好事啊").length, 1);
        assert.equal(runtime.mainCalls, 2, "an explicit @ and the later active-conversation message use the existing model path");

        const mentionGroup = randomUUID();
        await fake.onMessage!({}, inbound("@小尘 好事啊", {
            groupId: mentionGroup,
            memberOpenid: "mention-a",
            eventType: "GROUP_AT_MESSAGE_CREATE",
            mentions: [{ is_you: true, username: "小尘" }],
        }));
        await fake.onMessage!({}, inbound("@小尘 好事啊", {
            groupId: mentionGroup,
            memberOpenid: "mention-b",
            eventType: "GROUP_AT_MESSAGE_CREATE",
            mentions: [{ is_you: true, username: "小尘" }],
        }));
        assert.equal(fake.sent.filter((item) => item.method === "text" && item.content === "好事啊").length, 1,
            "two explicit @ messages are never repeated deterministically");
        assert.equal(runtime.mainCalls, 4);
    } finally {
        runtime.cleanup();
    }
});

test("an ordinary group event and member_openid determine candidate identity", async () => {
    configureMemberRepository(new MemoryMemberRepository());
    const fake = fakeBot();
    const runtime = register(fake);
    const groupId = randomUUID();
    try {
        await fake.onMessage!({}, inbound("same", { groupId, memberOpenid: "member-a" }));
        await fake.onMessage!({}, inbound("same", {
            groupId,
            memberOpenid: "member-b",
            eventType: "SYSTEM_EVENT",
        }));
        assert.equal(fake.sent.filter((item) => item.method === "text" && item.content === "same").length, 0);

        await fake.onMessage!({}, inbound("same", { groupId, memberOpenid: "member-b" }));
        assert.equal(fake.sent.filter((item) => item.method === "text" && item.content === "same").length, 1);
    } finally {
        runtime.cleanup();
    }
});
