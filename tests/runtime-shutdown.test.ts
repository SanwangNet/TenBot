import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { QQBot } from "@tencent-connect/qqbot-nodejs";
import type { NormalizedQqMessage } from "../src/qq/message/normalize-message.js";
import { coordinateAiReply, getActiveReplyCycleCount, shutdownReplyCoordinator } from "../src/qq/reply/coordinator.js";

function message(): NormalizedQqMessage {
    const groupId = randomUUID();
    return {
        source: {} as never,
        id: randomUUID(),
        kind: "group",
        eventType: "GROUP_MESSAGE_CREATE",
        content: "mention",
        displayContent: "mention",
        groupId,
        author: null,
        authorId: "member",
        authorName: "member",
        authorIsBot: false,
        mentions: [],
        attachments: [],
        replyTarget: { scope: "group", targetId: groupId, msgId: randomUUID() },
        raw: {},
    } as NormalizedQqMessage;
}

test("Runtime shutdown aborts active model attempts and drains reply cycles", async () => {
    const value = message();
    let signal: AbortSignal | undefined;
    const pendingCycle = coordinateAiReply({
        bot: {} as QQBot,
        message: value,
        aiInput: "offline",
        imageUrls: [],
        isGroup: true,
        wakeLevel: "hard",
        wakeReason: "hard-mention",
        onWebSearchStart: () => undefined,
    }, {
        executeAi: async (_input, options) => await new Promise((_resolve, reject) => {
            signal = options.signal;
            options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    });

    for (let count = 0; count < 100 && !signal; count++) await new Promise((resolve) => setTimeout(resolve, 1));
    assert.ok(signal);
    assert.equal(getActiveReplyCycleCount(), 1);
    await shutdownReplyCoordinator();
    await pendingCycle;
    assert.equal(signal.aborted, true);
    assert.equal(getActiveReplyCycleCount(), 0);
});
