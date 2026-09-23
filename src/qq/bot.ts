import { QQBot } from "@tencent-connect/qqbot-nodejs";

import { registerInteractionHandler } from "./handlers/interaction-handler.js";
import { registerMessageHandler } from "./handlers/message-handler.js";

export function createQqBot(): QQBot {
    const appId = process.env.QQBOT_APP_ID;
    const appSecret = process.env.QQBOT_APP_SECRET;

    if (!appId || !appSecret) {
        throw new Error("缺少 QQBOT_APP_ID 或 QQBOT_APP_SECRET");
    }

    const bot = new QQBot({
        appId,
        appSecret,
        logger: console,
        markdownSupport: true,
    });

    bot.on("ready", () => {
        console.log("QQ Bot 已连接");
    });

    bot.on("error", (error) => {
        console.error("QQ Bot 错误：", error);
    });

    bot.on("rawEvent", (context) => {
        if (
            context.eventType === "GROUP_MESSAGE_CREATE" ||
            context.eventType === "GROUP_AT_MESSAGE_CREATE"
        ) {
            console.log("[GROUP EVENT]", context.eventType);
        }
    });

    registerMessageHandler(bot);
    registerInteractionHandler(bot);

    return bot;
}
