import type { QQBot } from "@tencent-connect/qqbot-nodejs";

import { sendMinecraftStatus } from "../minecraft-status.js";

export function registerInteractionHandler(bot: QQBot): void {
    bot.on("interaction", async (_context, event) => {
        const buttonData = event.data.resolved.button_data;

        console.log("按钮点击：", buttonData);
        await bot.acknowledgeInteraction(event.id, 0);

        if (buttonData === "minecraft_status_refresh") {
            console.log("用户要求刷新 Minecraft 状态");

            if (!event.group_openid) {
                console.error("刷新失败：没有 group_openid");
                return;
            }

            await sendMinecraftStatus(bot, {
                scope: "group",
                targetId: event.group_openid,
            });
        }
    });
}
