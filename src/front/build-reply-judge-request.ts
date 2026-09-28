import { getCurrentMessageTimestamp, getReplyJudgeHistory } from "../qq/conversation/recent-context.js";
import type { NormalizedQqMessage } from "../qq/message/normalize-message.js";
import { DEFAULT_BOT_TIME_ZONE, formatModelTimestamp } from "../ai/time-context.js";
import type { ReplyJudgeRequest } from "./reply-judge.js";

export function buildReplyJudgeRequest(
    message: NormalizedQqMessage,
    signals: ReplyJudgeRequest["signals"],
    time: { timeZone?: string; now?: Date } = {},
): ReplyJudgeRequest {
    const timeZone = time.timeZone ?? DEFAULT_BOT_TIME_ZONE;
    const now = time.now ?? new Date();
    return Object.freeze({
        conversation: Object.freeze(getReplyJudgeHistory(message).map((item) => Object.freeze({
            ...item,
            timestamp: formatModelTimestamp(item.timestamp, timeZone),
        }))),
        currentMessage: Object.freeze({
            speaker: message.authorName || "群友",
            content: message.displayContent.slice(0, 1_000),
            timestamp: formatModelTimestamp(getCurrentMessageTimestamp(message), timeZone),
        }),
        temporalContext: Object.freeze({
            currentTime: formatModelTimestamp(now, timeZone),
            timeZone,
        }),
        signals: Object.freeze({
            nameMention: signals.nameMention,
            conversationActive: signals.conversationActive,
            quotedBot: signals.quotedBot,
            turnWaitExpired: signals.turnWaitExpired,
        }),
    });
}
