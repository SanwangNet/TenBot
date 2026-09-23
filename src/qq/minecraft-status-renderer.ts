import type { InlineKeyboard } from "@tencent-connect/qqbot-nodejs";

import type { MinecraftStatusResult } from "../skills/minecraft-status.js";

export function renderMinecraftStatus(
    status: MinecraftStatusResult,
): {
    text: string;
    keyboard: InlineKeyboard;
} {
    const text = status.online
        ? [
              "## Minecraft 服务器",
              "",
              "**状态：** 在线",
              status.playersOnline !== undefined &&
              status.playersMax !== undefined
                  ? `**玩家：** ${status.playersOnline} / ${status.playersMax}`
                  : null,
              status.latencyMs !== undefined
                  ? `**延迟：** ${status.latencyMs} ms`
                  : null,
              status.version
                  ? `**版本：** ${status.version}`
                  : null,
          ]
              .filter(Boolean)
              .join("\n")
        : [
              "## Minecraft 服务器",
              "",
              "**状态：** 离线或无法连接",
          ].join("\n");

    const keyboard: InlineKeyboard = {
        content: {
            rows: [
                {
                    buttons: [
                        {
                            id: "minecraft_status_refresh",
                            render_data: {
                                label: "刷新",
                                visited_label: "再次刷新",
                                style: 1,
                            },
                            action: {
                                type: 1,
                                permission: {
                                    type: 2,
                                },
                                data: "minecraft_status_refresh",
                            },
                        },
                    ],
                },
            ],
        },
    };

    return {
        text,
        keyboard,
    };
}