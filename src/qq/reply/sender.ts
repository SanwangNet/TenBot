import { MsgType, type QQBot } from "@tencent-connect/qqbot-nodejs";

import type { QqReplyAction } from "../../ai/reply-result.js";
import { renderStructuredMentions } from "./mentions.js";
import type { NormalizedQqMessage } from "../message/normalize-message.js";

export function getTriggerMessageId(message: NormalizedQqMessage): string | undefined {
    return message.id ?? message.replyTarget.msgId;
}

export async function prepareAiReply(message: NormalizedQqMessage, action: QqReplyAction) {
    return renderStructuredMentions(message, action.content, action.mentions);
}

/** Keep Tencent payload fields in one place. */
export async function sendAiReply(
    bot: QQBot,
    message: NormalizedQqMessage,
    rendered: Awaited<ReturnType<typeof prepareAiReply>>,
    quoteTrigger: boolean,
    beforeSend: () => boolean,
): Promise<boolean> {
    const triggerMessageId = getTriggerMessageId(message);

    // This check and the QQ call have no await between them.
    if (!beforeSend()) return false;

    if (quoteTrigger && triggerMessageId) {
        await bot.send({
            target: message.replyTarget,
            msgType: MsgType.MARKDOWN,
            markdown: { content: rendered.sendText },
            messageReference: { message_id: triggerMessageId },
        });
    } else {
        await bot.sendMarkdown(message.replyTarget, rendered.sendText);
    }

    return true;
}

export async function sendTimeoutReply(
    bot: QQBot,
    message: NormalizedQqMessage,
    content: string,
    quoteTrigger: boolean,
): Promise<void> {
    const triggerMessageId = getTriggerMessageId(message);
    if (quoteTrigger && triggerMessageId) {
        await bot.send({
            target: message.replyTarget,
            msgType: MsgType.MARKDOWN,
            markdown: { content },
            messageReference: { message_id: triggerMessageId },
        });
    } else {
        await bot.sendText(message.replyTarget, content);
    }
}
