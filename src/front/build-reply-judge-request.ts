import { getReplyJudgeHistory } from "../qq/conversation/recent-context.js";
import type { NormalizedQqMessage } from "../qq/message/normalize-message.js";
import type { ReplyJudgeRequest } from "./reply-judge.js";

export function buildReplyJudgeRequest(
    message: NormalizedQqMessage,
    signals: ReplyJudgeRequest["signals"],
): ReplyJudgeRequest {
    return Object.freeze({
        conversation: Object.freeze(getReplyJudgeHistory(message)),
        currentMessage: Object.freeze({
            speaker: message.authorName || "群友",
            content: message.displayContent.slice(0, 1_000),
        }),
        signals: Object.freeze({
            nameMention: signals.nameMention,
            conversationActive: signals.conversationActive,
            quotedBot: signals.quotedBot,
            turnWaitExpired: signals.turnWaitExpired,
        }),
    });
}
