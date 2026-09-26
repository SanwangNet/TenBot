import { QQBot, quoteRef } from "@tencent-connect/qqbot-nodejs";

import { logger, qqSdkLogger } from "../shared/logger.js";
import { registerInteractionHandler } from "./handlers/interaction-handler.js";
import { registerMessageHandler } from "./handlers/message-handler.js";
import type { NormalizedQqMessage } from "./message/normalize-message.js";
import type { ReplyJudge } from "../front/reply-judge.js";
import type { FrontMode } from "../front/wake-level.js";
import type { GroupReplyControl } from "../runtime/group-reply-control.js";

export type QqConnectionState = "connecting" | "connected" | "disconnected" | "error";
const messageHandlerCleanup = new WeakMap<QQBot, () => void>();

export function shutdownQqMessageHandler(bot: QQBot): void {
    const cleanup = messageHandlerCleanup.get(bot);
    messageHandlerCleanup.delete(bot);
    cleanup?.();
}

export function createQqBot(
    onConnectionState?: (state: QqConnectionState) => void,
    observePeer?: (message: NormalizedQqMessage) => void,
    observeConversationMessage?: (message: NormalizedQqMessage) => void,
    connectionConfig?: { appId?: string; appSecret?: string },
    replyJudge?: ReplyJudge,
    getFrontMode?: () => FrontMode,
    getReplyJudgeIpoFallbackToMain?: () => boolean,
    getReplyJudgeTurnWaitMs?: () => number,
    groupReplyControl?: GroupReplyControl,
    getBotAdminIds?: () => readonly string[],
): QQBot {
    const appId = connectionConfig ? connectionConfig.appId : process.env.QQBOT_APP_ID;
    const appSecret = connectionConfig ? connectionConfig.appSecret : process.env.QQBOT_APP_SECRET;

    if (!appId || !appSecret) {
        throw new Error("缺少 QQBOT_APP_ID 或 QQBOT_APP_SECRET");
    }

    const bot = new QQBot({
        appId,
        appSecret,
        logger: qqSdkLogger,
        markdownSupport: true,
    });
    bot.use(quoteRef({ preferMsgElements: false }));

    bot.on("ready", () => {
        onConnectionState?.("connected");
        logger.info("QQ Bot 已连接");
    });

    bot.on("error", (error) => {
        onConnectionState?.("error");
        logger.error("[QQ] error", error);
    });

    bot.on("rawEvent", (context) => {
        if (
            context.eventType === "GROUP_MESSAGE_CREATE" ||
            context.eventType === "GROUP_AT_MESSAGE_CREATE"
        ) {
            logger.debug("[QQ event]", context.eventType);
        }
    });

    messageHandlerCleanup.set(bot, registerMessageHandler(bot, undefined, observePeer, observeConversationMessage,
        replyJudge, {}, getFrontMode, getReplyJudgeIpoFallbackToMain, getReplyJudgeTurnWaitMs,
        undefined, groupReplyControl, getBotAdminIds));
    registerInteractionHandler(bot);

    return bot;
}
