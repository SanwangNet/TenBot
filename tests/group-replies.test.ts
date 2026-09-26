import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { QQBot, QQBotInboundMessage } from "@tencent-connect/qqbot-nodejs";

import { GroupReplyControl } from "../src/runtime/group-reply-control.js";
import { toOpaqueMemberDisplayId } from "../src/members/opaque-member-id.js";
import { registerMessageHandler, type ReplyJudgeTurnWaitScheduler } from "../src/qq/handlers/message-handler.js";
import { getMessageRevision } from "../src/qq/conversation/recent-context.js";
import { normalizeQqMessage } from "../src/qq/message/normalize-message.js";

function fakeBot() {
    const sent: string[] = [];
    let onMessage: ((context: unknown, message: QQBotInboundMessage) => Promise<void>) | undefined;
    const bot = {
        on(event: string, handler: (context: unknown, message: QQBotInboundMessage) => Promise<void>) {
            if (event === "message") onMessage = handler;
        },
        async sendText(_target: unknown, content: string) { sent.push(content); },
        async sendMarkdown(_target: unknown, content: string) { sent.push(content); },
    } as unknown as QQBot;
    return { bot, sent, get onMessage() { return onMessage; } };
}

function incoming(content: string, options: { hard?: boolean; memberOpenid?: string; name?: string } = {}): QQBotInboundMessage {
    const groupId = `group-${randomUUID()}`;
    const memberOpenid = options.memberOpenid ?? "member-one";
    return {
        kind: "group",
        rawEventType: options.hard ? "GROUP_AT_MESSAGE_CREATE" : "GROUP_MESSAGE_CREATE",
        messageId: randomUUID(),
        content,
        groupOpenid: groupId,
        senderId: memberOpenid,
        senderName: options.name ?? "same nickname",
        timestamp: new Date().toISOString(),
        replyTarget: { scope: "group", targetId: groupId, msgId: randomUUID() },
        mentions: options.hard ? [{ is_you: true, username: "小尘" }] : [],
        attachments: [],
        raw: {
            group_openid: groupId,
            author: { member_openid: memberOpenid, username: options.name ?? "same nickname" },
            mentions: options.hard ? [{ is_you: true, username: "小尘" }] : [],
        },
    } as unknown as QQBotInboundMessage;
}

function fakeControl(initial = false) {
    let enabled = initial;
    let writes = 0;
    const control = new GroupReplyControl({
        async getGroupRepliesEnabled() { return enabled; },
        async setGroupRepliesEnabled(next) { writes++; enabled = next; },
    });
    return { control, get enabled() { return enabled; }, get writes() { return writes; } };
}

test("hard-mentioned admin commands are local, exact, authorized by stable member OpenID, and idempotent", async () => {
    const state = fakeControl(true);
    await state.control.initialize();
    const adminOpenid = "stable-admin-openid";
    const adminId = toOpaqueMemberDisplayId(adminOpenid);
    const fake = fakeBot();
    const dispose = registerMessageHandler(fake.bot, undefined, undefined, undefined, undefined, {}, undefined,
        undefined, undefined, undefined, state.control, () => [adminId.toLowerCase()]);
    try {
        assert.ok(fake.onMessage);
        const disable = incoming("/停用", { hard: true, memberOpenid: adminOpenid });
        const disableNormalized = await normalizeQqMessage({}, disable);
        await fake.onMessage({}, disable);
        assert.equal(state.enabled, false);
        assert.deepEqual(fake.sent, ["已停用"]);
        assert.equal(getMessageRevision(disableNormalized), 0);
        assert.equal(state.writes, 1);

        await fake.onMessage({}, incoming("/停用", { hard: true, memberOpenid: adminOpenid }));
        assert.equal(state.enabled, false);
        assert.equal(state.writes, 1, "repeated disable does not write SQLite again");

        const enable = incoming("/启用", { hard: true, memberOpenid: adminOpenid });
        const enableNormalized = await normalizeQqMessage({}, enable);
        await fake.onMessage({}, enable);
        assert.equal(state.enabled, true);
        assert.deepEqual(fake.sent, ["已停用", "已停用", "已启用"]);
        assert.equal(getMessageRevision(enableNormalized), 0);
        assert.equal(state.writes, 2);

        await fake.onMessage({}, incoming("/启用", { hard: true, memberOpenid: adminOpenid }));
        assert.equal(state.enabled, true);
        assert.equal(state.writes, 2, "repeated enable does not write SQLite again");

        await fake.onMessage({}, incoming("/停用", { memberOpenid: adminOpenid }));
        assert.equal(state.enabled, true, "without a hard Bot mention the admin command is not executed");

        const unauthorized = incoming("/停用", { hard: true, memberOpenid: "different-member", name: "same nickname" });
        await fake.onMessage({}, unauthorized);
        assert.equal(state.enabled, true);
        assert.equal(fake.sent.at(-1), "无权限");

        const notExact = incoming("/停用 之后再说", { hard: true, memberOpenid: adminOpenid });
        await fake.onMessage({}, notExact);
        assert.equal(state.enabled, true);
    } finally {
        dispose();
    }
});

test("disabled groups keep context, skip Judge, and answer only a hard mention with the fixed local notice", async () => {
    const state = fakeControl(false);
    await state.control.initialize();
    const fake = fakeBot();
    let judgeCalls = 0;
    const dispose = registerMessageHandler(fake.bot, undefined, undefined, undefined, {
        async judge() { judgeCalls++; return { decision: "pass" }; },
    }, {}, () => "judge", undefined, undefined, undefined, state.control);
    try {
        assert.ok(fake.onMessage);
        const ordinary = incoming("群里普通聊天");
        const ordinaryNormalized = await normalizeQqMessage({}, ordinary);
        await fake.onMessage({}, ordinary);
        assert.equal(getMessageRevision(ordinaryNormalized), 1);
        assert.equal(judgeCalls, 0);
        assert.deepEqual(fake.sent, []);

        const hard = incoming("你好", { hard: true });
        const hardNormalized = await normalizeQqMessage({}, hard);
        await fake.onMessage({}, hard);
        assert.equal(getMessageRevision(hardNormalized), 1);
        assert.equal(judgeCalls, 0);
        assert.deepEqual(fake.sent, ["模型暂不可用"]);
    } finally {
        dispose();
    }
});

test("disabling cancels the handler's pending turn-wait timer and invalidates its callback", async () => {
    const state = fakeControl(true);
    await state.control.initialize();
    const fake = fakeBot();
    let judgeCalls = 0;
    let timerCallback: (() => void) | undefined;
    let cleared = 0;
    const scheduler: ReplyJudgeTurnWaitScheduler = {
        setTimeout(callback) {
            timerCallback = callback;
            return setTimeout(() => undefined, 60_000);
        },
        clearTimeout(timer) { cleared++; clearTimeout(timer); },
        unref(timer) { timer.unref?.(); },
    };
    const dispose = registerMessageHandler(fake.bot, undefined, undefined, undefined, {
        async judge() { judgeCalls++; return { decision: "wait" }; },
    }, {}, () => "judge", undefined, () => 20_000, scheduler, state.control);
    try {
        assert.ok(fake.onMessage);
        await fake.onMessage({}, incoming("因为模型的输入规律就是"));
        assert.equal(judgeCalls, 1);
        assert.ok(timerCallback);
        await state.control.setGroupRepliesEnabled(false, "4D53C611");
        assert.equal(cleared, 1);
        timerCallback();
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(judgeCalls, 1);
    } finally {
        dispose();
    }
});

test("disabling aborts an in-flight Reply Judge request", async () => {
    const state = fakeControl(true);
    await state.control.initialize();
    const fake = fakeBot();
    let judgeSignal: AbortSignal | undefined;
    const dispose = registerMessageHandler(fake.bot, undefined, undefined, undefined, {
        judge(_request, signal) {
            judgeSignal = signal;
            return new Promise((_resolve, reject) => {
                signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
            });
        },
    }, {}, () => "judge", undefined, undefined, undefined, state.control);
    try {
        assert.ok(fake.onMessage);
        const pending = fake.onMessage({}, incoming("问个问题"));
        await new Promise((resolve) => setImmediate(resolve));
        assert.ok(judgeSignal);
        await state.control.setGroupRepliesEnabled(false, "4D53C611");
        assert.equal(judgeSignal.aborted, true);
        await pending;
        assert.deepEqual(fake.sent, []);
    } finally {
        dispose();
    }
});
