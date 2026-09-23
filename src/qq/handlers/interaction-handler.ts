import type { QQBot } from "@tencent-connect/qqbot-nodejs";

import { logger } from "../../shared/logger.js";
import { sendMinecraftStatus } from "../minecraft-status.js";

export function registerInteractionHandler(bot: QQBot): void {
    bot.on("interaction", async (_context, event) => {
        const buttonData = event.data.resolved.button_data;

        logger.debug("[Interaction] button", buttonData);
        await bot.acknowledgeInteraction(event.id, 0);

        if (buttonData === "minecraft_status_refresh") {
            logger.info("[MC] refresh");

            if (!event.group_openid) {
                logger.error("[MC] refresh failed: missing group id");
                return;
            }

            await sendMinecraftStatus(bot, {
                scope: "group",
                targetId: event.group_openid,
            });
        }
    });
}
