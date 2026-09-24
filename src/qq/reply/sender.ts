import { MsgType, type QQBot } from "@tencent-connect/qqbot-nodejs";

import type { RenderedQQReply } from "./renderer.js";
import type { NormalizedQqMessage } from "../message/normalize-message.js";

export function getTriggerMessageId(message: NormalizedQqMessage): string | undefined {
    return message.id ?? message.replyTarget.msgId;
}

/** Keep Tencent payload fields in one place. */
export async function sendAiReply(
    bot: QQBot,
    message: NormalizedQqMessage,
    rendered: RenderedQQReply,
    quoteMessageId: string | undefined,
    beforeSend: () => boolean,
): Promise<{ sent: boolean; id?: string; refIdx?: string }> {

    // This check and the QQ call have no await between them.
    if (!beforeSend()) return { sent: false };

    const response = quoteMessageId ? await bot.send({
            target: message.replyTarget,
            msgType: MsgType.MARKDOWN,
            markdown: { content: rendered.sendText },
            messageReference: { message_id: quoteMessageId },
        }) : await bot.sendMarkdown(message.replyTarget, rendered.sendText);

    return { sent: true, id: response?.id, refIdx: response?.ext_info?.ref_idx };
}

export async function sendTimeoutReply(
    bot: QQBot,
    message: NormalizedQqMessage,
    content: string,
    quoteTrigger: boolean,
): Promise<{ id?: string; refIdx?: string }> {
    const triggerMessageId = getTriggerMessageId(message);
    const response = quoteTrigger && triggerMessageId ? await bot.send({
        target: message.replyTarget,
        msgType: MsgType.MARKDOWN,
        markdown: { content },
        messageReference: { message_id: triggerMessageId },
    }) : await bot.sendText(message.replyTarget, content);
    return { id: response?.id, refIdx: response?.ext_info?.ref_idx };
}
