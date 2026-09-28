import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { buildAiInput } from "../src/ai/input-builder.js";
import { buildTemporalContext, formatModelTimestamp } from "../src/ai/time-context.js";
import { loadAppConfig, toPublicConfig } from "../src/config/config-validation.js";
import { buildReplyJudgeRequest } from "../src/front/build-reply-judge-request.js";
import { getReplyJudgeHistory, recordIncomingMessageRevision, rememberBotReply, rememberIncomingMessage, buildReplyCycleSnapshot } from "../src/qq/conversation/recent-context.js";
import type { NormalizedQqMessage } from "../src/qq/message/normalize-message.js";
import { parseQqReplyArguments } from "../src/skills/qq-reply/skill.js";

function inbound(groupId: string, id: string, timestamp: string, content: string): NormalizedQqMessage {
    return {
        source: { msgIdx: `ref-${id}` } as never,
        id,
        kind: "group",
        eventType: "GROUP_MESSAGE_CREATE",
        content,
        displayContent: content,
        groupId,
        author: null,
        authorId: `member-${id}`,
        authorName: "群友",
        authorIsBot: false,
        mentions: [],
        attachments: [],
        replyTarget: { scope: "group", targetId: groupId, msgId: id } as never,
        timestamp,
        raw: {},
    };
}

function remember(message: NormalizedQqMessage): void {
    recordIncomingMessageRevision(message);
    rememberIncomingMessage(message, message.displayContent);
}

test("BOT_TIME_ZONE validation defaults to Shanghai and accepts Intl-supported IANA names", () => {
    assert.equal(loadAppConfig({}).botTimeZone, "Asia/Shanghai");
    for (const zone of ["Asia/Shanghai", "Asia/Tokyo", "UTC", "America/New_York"]) {
        assert.equal(loadAppConfig({ BOT_TIME_ZONE: zone }).botTimeZone, zone);
    }
    for (const zone of ["UTC+8", "GMT+8", "CST", "invalid-zone"]) {
        assert.throws(() => loadAppConfig({ BOT_TIME_ZONE: zone }), /BOT_TIME_ZONE/);
    }
    const publicConfig = toPublicConfig(loadAppConfig({ BOT_TIME_ZONE: "Asia/Tokyo" }));
    assert.equal("botTimeZone" in publicConfig, false);
    assert.equal("BOT_TIME_ZONE" in publicConfig, false);
});

test("model timestamp formatting is stable, timezone-explicit, and independent of host timezone", () => {
    const instant = new Date("2026-09-28T09:31:42.000Z");
    assert.equal(formatModelTimestamp(instant, "Asia/Shanghai"), "2026-09-28 17:31:42");
    assert.equal(formatModelTimestamp(instant, "Asia/Tokyo"), "2026-09-28 18:31:42");
    assert.equal(formatModelTimestamp(instant, "UTC"), "2026-09-28 09:31:42");
    assert.match(formatModelTimestamp(instant, "UTC"), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.equal(buildTemporalContext(instant, "Asia/Shanghai"), [
        "<temporal_context>",
        "current_time=2026-09-28 17:31:42",
        "timezone=Asia/Shanghai",
        "</temporal_context>",
    ].join("\n"));
});

test("Main Model and Reply Judge inputs carry one current time and original per-message timestamps", () => {
    const group = randomUUID();
    const earlier = inbound(group, "earlier", "2026-09-28T09:00:00.000Z", "刚下班");
    const current = inbound(group, "current", "2026-09-28T09:05:00.000Z", "这么晚了");
    remember(earlier);
    remember(current);

    const fixedNow = new Date("2026-09-28T09:31:42.000Z");
    const snapshot = buildReplyCycleSnapshot(current, "Asia/Shanghai");
    const mainInput = buildAiInput(snapshot.text, "", "policy", "", buildTemporalContext(fixedNow, "Asia/Shanghai"));
    assert.match(mainInput, /current_time=2026-09-28 17:31:42/);
    assert.match(mainInput, /timezone=Asia\/Shanghai/);
    assert.match(mainInput, /\[m1\]\[2026-09-28 17:00:00\] 群友：刚下班/);
    assert.match(mainInput, /\[m2\]\[2026-09-28 17:05:00\] 群友：这么晚了/);
    assert.equal(snapshot.refs.get("m1"), "earlier");
    assert.equal(snapshot.refs.get("m2"), "current");
    const quoteArguments = parseQqReplyArguments(JSON.stringify({
        messages: [{ content: "回复", quote: { mode: "message", ref: "m1" } }],
        mentions: [],
    }));
    assert.deepEqual(quoteArguments?.messages[0]?.quote, { mode: "message", ref: "m1" });

    const judge = buildReplyJudgeRequest(current, {
        nameMention: false,
        conversationActive: false,
        quotedBot: false,
        turnWaitExpired: false,
    }, { timeZone: "Asia/Shanghai", now: fixedNow });
    assert.deepEqual(judge.temporalContext, { currentTime: "2026-09-28 17:31:42", timeZone: "Asia/Shanghai" });
    assert.deepEqual(judge.conversation, [{ speaker: "群友", content: "刚下班", timestamp: "2026-09-28 17:00:00" }]);
    assert.deepEqual(judge.currentMessage, { speaker: "群友", content: "这么晚了", timestamp: "2026-09-28 17:05:00" });

    const tokyoSnapshot = buildReplyCycleSnapshot(current, "Asia/Tokyo");
    assert.match(tokyoSnapshot.text, /\[m1\]\[2026-09-28 18:00:00\]/);
    assert.equal(getReplyJudgeHistory(current)[0]?.timestamp, Date.parse("2026-09-28T09:00:00.000Z"));
});

test("Recent Context retains dates across midnight and records bot send timestamps", () => {
    const group = randomUUID();
    const beforeMidnight = inbound(group, "before-midnight", "2026-09-28T15:59:59.000Z", "昨天还在聊");
    const afterMidnight = inbound(group, "after-midnight", "2026-09-28T16:00:01.000Z", "今天继续");
    remember(beforeMidnight);
    remember(afterMidnight);
    const context = buildReplyCycleSnapshot(afterMidnight, "Asia/Shanghai").text;
    assert.match(context, /\[m1\]\[2026-09-28 23:59:59\] 群友：昨天还在聊/);
    assert.match(context, /\[m2\]\[2026-09-29 00:00:01\] 群友：今天继续/);

    const botGroup = randomUUID();
    const trigger = inbound(botGroup, "trigger", "2026-09-28T09:00:00.000Z", "问候");
    remember(trigger);
    const sentTimestamp = "2026-09-28T09:33:21.000Z";
    rememberBotReply(trigger, "你好", { id: "bot-reply", timestamp: sentTimestamp });
    const next = inbound(botGroup, "next", "2026-09-28T09:34:00.000Z", "继续");
    remember(next);
    const botEntry = getReplyJudgeHistory(next).find((item) => item.speaker === "小尘");
    assert.equal(botEntry?.timestamp, Date.parse(sentTimestamp));
    assert.match(buildReplyCycleSnapshot(next, "Asia/Shanghai").text, /\[m2\]\[2026-09-28 17:33:21\] 小尘：你好/);
});
