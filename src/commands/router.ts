import type { QQBot } from "@tencent-connect/qqbot-nodejs";

import { logger } from "../shared/logger.js";
import { getKnownMembers, renderMentions } from "../qq/conversation/known-members.js";
import type { NormalizedQqMessage } from "../qq/message/normalize-message.js";
import { sendMinecraftStatus } from "../qq/minecraft-status.js";

export interface CommandContext {
    bot: QQBot;
    message: NormalizedQqMessage;
    args: string;
}

export interface BotCommand {
    name: string;
    aliases?: string[];
    description: string;
    execute(context: CommandContext): Promise<void>;
}

export interface ParsedCommand {
    name: string;
    args: string;
}

function isBotMentioned(message: NormalizedQqMessage): boolean {
    return message.eventType === "GROUP_AT_MESSAGE_CREATE" ||
        message.mentions.some((mention) => {
            const value = mention as { isSelf?: boolean; is_you?: boolean; isYou?: boolean };
            return value.isSelf === true || value.is_you === true || value.isYou === true;
        });
}

function visibleCommandText(message: NormalizedQqMessage): string {
    const withDisplay = message as NormalizedQqMessage & { displayContent?: string };
    let text = (withDisplay.displayContent ?? message.content).trimStart();
    if (/^@小尘(?:\s|$)/.test(text)) {
        text = text.replace(/^@小尘\s*/, "");
    } else if (isBotMentioned(message)) {
        text = text.replace(/^<@[^>]+>\s*/, "").replace(/^@\S+\s*/, "");
    }
    return text;
}

/** Only a leading slash after an optional bot mention enters the command namespace. */
export function parseCommand(message: NormalizedQqMessage): ParsedCommand | null {
    const text = visibleCommandText(message);
    if (!text.startsWith("/")) return null;
    const match = /^\/(\S*)(?:\s+([\s\S]*))?$/.exec(text);
    if (!match) return { name: text.slice(1), args: "" };
    return { name: match[1].toLowerCase(), args: (match[2] ?? "").trim() };
}

const commands: BotCommand[] = [
    {
        name: "help",
        description: "查看可用命令",
        async execute({ bot, message }) {
            const lines = commands.map((command) =>
                "/" + command.name +
                (command.aliases?.length ? " (" + command.aliases.map((alias) => "/" + alias).join(", ") + ")" : "") +
                " - " + command.description,
            );
            await bot.sendText(message.replyTarget, ["可用命令：", ...lines].join("\n"));
        },
    },
    {
        name: "mc",
        description: "查看 Minecraft 服务器状态",
        async execute({ bot, message }) {
            await sendMinecraftStatus(bot, message.replyTarget);
        },
    },
    {
        name: "members",
        description: "查看目前认识的群成员",
        async execute({ bot, message }) {
            const members = getKnownMembers(message);
            const text = members.length > 0
                ? members.map((member) => member.username + " (" + (member.role ?? "member") + ")").join("\n")
                : "目前还不认识任何群友。";
            await bot.sendText(message.replyTarget, text);
        },
    },
    {
        name: "at",
        description: "测试 @ 已知群成员",
        async execute({ bot, message, args }) {
            if (!args) {
                await bot.sendText(message.replyTarget, "用法：/at 昵称");
                return;
            }
            const rendered = renderMentions(message, "<mention>" + args + "</mention> 测试一下");
            await bot.sendMarkdown(message.replyTarget, rendered.sendText);
        },
    },
];

const registry = new Map<string, BotCommand>();
for (const command of commands) {
    for (const name of [command.name, ...(command.aliases ?? [])]) {
        if (registry.has(name)) throw new Error("Duplicate command: " + name);
        registry.set(name, command);
    }
}

export function listCommands(): readonly BotCommand[] {
    return commands;
}

/** Returns true for every slash input, including unknown or failed commands. */
export async function routeCommand(bot: QQBot, message: NormalizedQqMessage): Promise<boolean> {
    const parsed = parseCommand(message);
    if (!parsed) return false;
    const command = registry.get(parsed.name);
    const label = "/" + parsed.name;
    if (!command) {
        logger.info("[Command] unknown " + label);
        try {
            await bot.sendText(message.replyTarget,
                "未知命令 " + label + "\n使用 /help 查看可用命令");
        } catch (error) {
            logger.error("[Command] unknown reply error", error);
        }
        return true;
    }

    logger.info("[Command] /" + command.name);
    try {
        await command.execute({ bot, message, args: parsed.args });
    } catch (error) {
        logger.error("[Command] /" + command.name + " error", error);
        try {
            await bot.sendText(message.replyTarget, "命令执行失败，请稍后重试。");
        } catch (sendError) {
            logger.error("[Command] error reply failed", sendError);
        }
    }
    return true;
}
