import { MsgType, type QQBot } from "@tencent-connect/qqbot-nodejs";

import type { RenderedQQReply } from "./renderer.js";
import type { NormalizedQqMessage } from "../message/normalize-message.js";
import { logger } from "../../shared/logger.js";

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
): Promise<{ sent: boolean; id?: string; refIdx?: string; timestamp?: number | string }> {

    // This check and the QQ call have no await between them.
    if (!beforeSend()) return { sent: false };

    const payload = quoteMessageId ? {
            target: message.replyTarget,
            msgType: MsgType.MARKDOWN,
            markdown: { content: rendered.sendText },
            messageReference: { message_id: quoteMessageId },
        } : undefined;
    logger.all("[QQ] outbound request", payload ?? { target: message.replyTarget, markdown: rendered.sendText });
    const response = payload ? await bot.send(payload) : await bot.sendMarkdown(message.replyTarget, rendered.sendText);
    logger.all("[QQ] outbound response", response);

    return { sent: true, id: response?.id, refIdx: response?.ext_info?.ref_idx, timestamp: response?.timestamp };
}

/** Send a selected library image as its own QQ message after all text replies. */
export async function sendAiMeme(
    bot: QQBot,
    message: NormalizedQqMessage,
    localPath: string,
    beforeSend: () => boolean,
): Promise<{ sent: boolean; id?: string; refIdx?: string; timestamp?: number | string }> {
    if (!beforeSend()) return { sent: false };
    logger.all("[QQ] outbound image request", { target: message.replyTarget, localPath });
    const response = await bot.sendImage(message.replyTarget, { localPath });
    logger.all("[QQ] outbound image response", response);
    return {
        sent: true,
        id: response.message?.id,
        refIdx: response.message?.ext_info?.ref_idx,
        timestamp: response.message?.timestamp,
    };
}

export async function sendTimeoutReply(
    bot: QQBot,
    message: NormalizedQqMessage,
    content: string,
    quoteTrigger: boolean,
): Promise<{ id?: string; refIdx?: string; timestamp?: number | string }> {
    const triggerMessageId = getTriggerMessageId(message);
    logger.all("[QQ] timeout outbound request", { target: message.replyTarget, content, quoteTrigger, triggerMessageId });
    const response = quoteTrigger && triggerMessageId ? await bot.send({
        target: message.replyTarget,
        msgType: MsgType.MARKDOWN,
        markdown: { content },
        messageReference: { message_id: triggerMessageId },
    }) : await bot.sendText(message.replyTarget, content);
    logger.all("[QQ] timeout outbound response", response);
    return { id: response?.id, refIdx: response?.ext_info?.ref_idx, timestamp: response?.timestamp };
}
