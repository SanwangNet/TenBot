import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { QQBot, QQBotInboundMessage } from "@tencent-connect/qqbot-nodejs";

import { listCommands, parseCommand, routeCommand } from "../src/commands/router.js";
import { buildChatInput } from "../src/qq/conversation/recent-context.js";
import { registerMessageHandler } from "../src/qq/handlers/message-handler.js";
import { normalizeQqMessage, type NormalizedQqMessage } from "../src/qq/message/normalize-message.js";

function message(content: string, mentionBot = false): NormalizedQqMessage {
    const groupId = randomUUID();
    return {
        kind: "group",
        eventType: mentionBot ? "GROUP_AT_MESSAGE_CREATE" : "GROUP_MESSAGE_CREATE",
        content,
        displayContent: content,
        groupId,
        mentions: mentionBot ? [{ isSelf: true, is_you: true, username: "小尘" }] : [],
        replyTarget: { scope: "group", targetId: groupId, msgId: randomUUID() },
        author: { member_openid: "author-1", username: "用户" },
        authorName: "用户",
        authorIsBot: false,
        attachments: [],
    } as unknown as NormalizedQqMessage;
}

function fakeBot() {
    const sent: Array<{ method: string; content: string }> = [];
    let onMessage: ((context: unknown, message: QQBotInboundMessage) => Promise<void>) | undefined;
    const bot = {
        on(event: string, handler: (context: unknown, message: QQBotInboundMessage) => Promise<void>) {
            if (event === "message") onMessage = handler;
        },
        async sendText(_target: unknown, content: string) {
            sent.push({ method: "text", content });
        },
        async sendMarkdown(_target: unknown, content: string) {
            sent.push({ method: "markdown", content });
        },
    } as unknown as QQBot;
    return { bot, sent, get onMessage() { return onMessage; } };
}

test("registry is the only source of help entries", async () => {
    const names = listCommands().map((command) => command.name);
    assert.deepEqual(names, ["help", "mc", "members", "at"]);
    const { bot, sent } = fakeBot();
    assert.equal(await routeCommand(bot, message("/help")), true);
    assert.equal(sent.length, 1);
    for (const name of names) {
        assert.match(sent[0].content, new RegExp("/" + name + " - "));
    }
});

test("parse slash commands and optional bot mentions", () => {
    assert.deepEqual(parseCommand(message("/mc")), { name: "mc", args: "" });
    assert.deepEqual(parseCommand(message("/at 张三 李四")), { name: "at", args: "张三 李四" });
    assert.deepEqual(parseCommand(message("@小尘 /mc", true)), { name: "mc", args: "" });
    assert.deepEqual(parseCommand(message("<@BOT_ID> /mc", true)), { name: "mc", args: "" });
    assert.deepEqual(parseCommand({ ...message("<@BOT_ID> /mc", true), displayContent: "@未知成员 /mc" } as NormalizedQqMessage), { name: "mc", args: "" });
    assert.equal(parseCommand(message("今天怎么这么热")), null);
    assert.equal(parseCommand(message("@别人 /mc")), null);
});

test("unknown slash input and legacy /ai prefix stay local", async () => {
    const { bot, sent } = fakeBot();
    assert.equal(await routeCommand(bot, message("/foo")), true);
    assert.equal(await routeCommand(bot, message("/ai 你好")), true);
    assert.equal(sent.length, 2);
    assert.match(sent[0].content, /未知命令 \/foo/);
    assert.match(sent[1].content, /未知命令 \/ai/);
});

test("message handler routes /help before context or AI", async () => {
    const fake = fakeBot();
    registerMessageHandler(fake.bot);
    const groupId = randomUUID();
    const source = {
        kind: "group",
        rawEventType: "GROUP_MESSAGE_CREATE",
        messageId: randomUUID(),
        content: "/help",
        groupOpenid: groupId,
        senderId: "author-1",
        senderName: "用户",
        timestamp: new Date().toISOString(),
        replyTarget: { scope: "group", targetId: groupId, msgId: randomUUID() },
        mentions: [],
        attachments: [],
        raw: {
            group_openid: groupId,
            mentions: [],
        },
    } as unknown as QQBotInboundMessage;
    assert.ok(fake.onMessage);
    await fake.onMessage({}, source);
    assert.equal(fake.sent.length, 1);
    assert.match(fake.sent[0].content, /可用命令/);
    const normalized = normalizeQqMessage({}, source);
    assert.doesNotMatch(buildChatInput(normalized, "下一句"), /\/help/);
});
