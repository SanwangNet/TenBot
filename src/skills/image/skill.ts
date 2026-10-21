import type { QQBot } from "@tencent-connect/qqbot-nodejs";

import { ImageGenerationError, type ImageGenerationService } from "../../ai/image-generation-service.js";
import type { NormalizedQqMessage } from "../../qq/message/normalize-message.js";
import { sendAiImage } from "../../qq/reply/sender.js";
import { logger } from "../../shared/logger.js";

export function imageGenerationPublicError(error: unknown): string {
    if (!(error instanceof ImageGenerationError)) return "图片生成失败，请稍后再试。";
    switch (error.code) {
        case "M:C_IG_DSB": return "AI 绘图功能目前未启用。";
        case "M:C_IG_EPR": return "请补充想生成的画面描述。";
        case "M:C_IG_DQL": return "你今天在本群的绘图次数已用完，请明天再试。";
        case "M:C_IG_BSY": return "你有一张图片正在生成，请稍等片刻。";
        case "M:C_IG_GBL": return "当前绘图任务较多，请稍后再试。";
        case "M:C_IG_DUP":
        case "M:C_IG_CAN": return "";
        case "M:C_IG_IDN": return "无法识别这条消息的身份，请重新发送绘图请求。";
        case "M:A_IG_CFG": return "AI 绘图配置暂时不可用，请联系管理员。";
        case "M:A_IG_TFW": return "图片已经生成，但保存到本地安全目录失败，请联系管理员。";
        case "M:A_IG_IRS": return "绘图服务返回了无效图片，请稍后再试。";
        case "M:A_IG_STO": return "绘图请求状态暂时无法保存，请稍后再试。";
        case "M:C_IG_SZM": return `所选尺寸 ${error.details?.requestedSize ?? ""} 与上游实际返回的 ${error.details?.actualSize ?? "未知尺寸"} 不一致，图片已留存但不会发送。`;
        case "R:A_MP_AUF": return "绘图上游鉴权失败，请联系管理员。";
        case "R:C_MP_RAT": return "绘图服务请求过于频繁，请稍后再试。";
        case "R:C_MP_PAR": return "当前绘图模型不接受已配置的参数，请联系管理员检查绘图设置。";
        case "R:C_MP_SIZ": return `绘图上游不支持所选尺寸 ${error.details?.requestedSize ?? ""}，没有自动更改尺寸或重试。`;
        case "R:A_MP_TMO": return "绘图请求超时，结果未能确认；系统不会自动重发，请确认状态后再手动重试。";
        default: return "绘图服务暂时无法完成请求，请稍后再试。";
    }
}

export async function runDirectImageCommand(input: {
    bot: QQBot;
    message: NormalizedQqMessage;
    prompt: string;
    service?: ImageGenerationService;
    groupRepliesEnabled?: (groupOpenid: string) => boolean;
}): Promise<void> {
    const { bot, message } = input;
    if (!input.prompt.trim()) {
        await bot.sendText(message.replyTarget, "用法：/绘图 一只在月球上吃泡面的猫");
        return;
    }
    if (message.kind === "group" && message.groupId && input.groupRepliesEnabled?.(message.groupId) === false) {
        await bot.sendText(message.replyTarget, "本群目前已停用机器人回复。");
        return;
    }
    if (!input.service?.isEnabled()) {
        await bot.sendText(message.replyTarget, "AI 绘图功能目前未启用。");
        return;
    }
    let generated: Awaited<ReturnType<ImageGenerationService["generate"]>> | undefined;
    let sendStatus: "quoted" | "unquoted" | "failed" | "unknown" = "failed";
    try {
        await bot.sendText(message.replyTarget, "图片开始生成了，请稍等片刻。");
        generated = await input.service.generate({
            prompt: input.prompt,
            groupOpenid: message.groupId,
            memberOpenid: message.authorId,
            messageId: message.id ?? message.replyTarget.msgId,
        });
        const sent = await sendAiImage(bot, message, generated.localPath, () => true);
        sendStatus = sent.status;
        await generated.complete(sendStatus);
        if (sendStatus === "failed") await bot.sendText(message.replyTarget, "图片已生成并留存在本地，但 QQ 明确拒绝了发送。");
        else if (sendStatus === "unknown") await bot.sendText(message.replyTarget, "图片已生成并留存在本地，但 QQ 是否收到尚无法确认，系统没有重复发送。");
    } catch (error) {
        logger.error(`[Image] direct request failed code=${error instanceof ImageGenerationError ? error.code : "unknown"}`);
        if (generated) {
            try { await generated.complete(sendStatus); }
            catch { logger.error("[Image] request status update failed"); }
        }
        const publicMessage = imageGenerationPublicError(error);
        if (publicMessage) {
            try { await bot.sendText(message.replyTarget, publicMessage); }
            catch { logger.error("[Image] failure notice send failed"); }
        }
    } finally {
        if (generated) {
            try { await generated.cleanup(); }
            catch { logger.error("[Image] intermediate file cleanup failed"); }
        }
    }
}
