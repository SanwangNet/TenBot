import type { QQBot } from "@tencent-connect/qqbot-nodejs";

import { runMinecraftStatus } from "../skills/minecraft-status.js";
import { renderMinecraftStatus } from "./minecraft-status-renderer.js";

export async function sendMinecraftStatus(
    bot: QQBot,
    target: Parameters<QQBot["sendTextWithKeyboard"]>[0],
): Promise<void> {
    const status = await runMinecraftStatus();
    const rendered = renderMinecraftStatus(status);
    await bot.sendTextWithKeyboard(target, rendered.text, rendered.keyboard);
}
