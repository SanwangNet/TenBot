import { MediaFileType, MsgType, type QQBot } from "@tencent-connect/qqbot-nodejs";

import type { RenderedQQReply } from "./renderer.js";
import type { NormalizedQqMessage } from "../message/normalize-message.js";
import { logger } from "../../shared/logger.js";

export function getTriggerMessageId(message: NormalizedQqMessage): string | undefined {
    return message.id ?? message.replyTarget.msgId;
}

export type GeneratedImageSendStatus = "quoted" | "unquoted" | "failed" | "unknown";

function explicitQqHttpStatus(error: unknown): number | undefined {
    const seen = new Set<object>();
    const queue: unknown[] = [error];
    while (queue.length && seen.size < 8) {
        const value = queue.shift();
        if (!value || typeof value !== "object" || seen.has(value)) continue;
        seen.add(value);
        const fields = value as Record<string, unknown>;
        for (const key of ["httpStatus", "status"] as const) {
            const status = fields[key];
            if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) return status;
        }
        for (const key of ["cause", "error", "response"] as const) {
            if (fields[key] !== undefined) queue.push(fields[key]);
        }
    }
    return undefined;
}

function definitelyRejectedByQq(error: unknown): boolean {
    const status = explicitQqHttpStatus(error);
    return status !== undefined && status >= 400 && status < 500;
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

/** Send a generated image as a standalone message, without a possibly expired quote. */
export async function sendAiImage(
    bot: QQBot,
    message: NormalizedQqMessage,
    localPath: string,
    beforeSend: () => boolean,
): Promise<{ sent: boolean; status: GeneratedImageSendStatus; id?: string; refIdx?: string; timestamp?: number | string }> {
    const triggerMessageId = getTriggerMessageId(message);
    if (!beforeSend() || !triggerMessageId) return { sent: false, status: "failed" };
    logger.debug("[Image] uploading generated image for native quote reply");
    let upload: Awaited<ReturnType<QQBot["uploadMedia"]>>;
    try {
        upload = await bot.uploadMedia({
            target: message.replyTarget,
            fileType: MediaFileType.IMAGE,
            localPath,
            srvSendMsg: false,
        });
    } catch {
        // srvSendMsg=false means an upload failure cannot have sent the image message.
        logger.warn("[Image] QQ media upload failed before image send");
        return { sent: false, status: "failed" };
    }
    if (!upload.file_info) return { sent: false, status: "failed" };

    try {
        const response = await bot.send({
            target: message.replyTarget,
            msgType: MsgType.MEDIA,
            media: { file_info: upload.file_info },
            messageReference: { message_id: triggerMessageId },
        });
        if (!response.id) return { sent: false, status: "unknown" };
        return { sent: true, status: "quoted", id: response.id,
            refIdx: response.ext_info?.ref_idx, timestamp: response.timestamp };
    } catch (error) {
        const status = explicitQqHttpStatus(error);
        if (status === undefined || status < 400 || status >= 500) {
            logger.warn("[Image] QQ quoted media send result is unknown");
            return { sent: false, status: "unknown" };
        }
        logger.debug(`[Image] QQ explicitly rejected quoted image status=${status}; retrying the uploaded media without a quote`);
    }

    try {
        const response = await bot.send({
            target: { scope: message.replyTarget.scope, targetId: message.replyTarget.targetId },
            msgType: MsgType.MEDIA,
            media: { file_info: upload.file_info },
        });
        if (!response.id) return { sent: false, status: "unknown" };
        return { sent: true, status: "unquoted", id: response.id,
            refIdx: response.ext_info?.ref_idx, timestamp: response.timestamp };
    } catch (error) {
        if (definitelyRejectedByQq(error)) return { sent: false, status: "failed" };
        logger.warn("[Image] QQ unquoted media send result is unknown");
        return { sent: false, status: "unknown" };
    }
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
