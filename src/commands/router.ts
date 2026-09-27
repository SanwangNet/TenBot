import type { QQBot } from "@tencent-connect/qqbot-nodejs";

import { logger } from "../shared/logger.js";
import { getKnownMembers } from "../qq/conversation/known-members.js";
import type { NormalizedQqMessage } from "../qq/message/normalize-message.js";
import { renderMentions } from "../qq/reply/mentions.js";
import { sendMinecraftStatus } from "../qq/minecraft-status.js";
import { MemeLibraryError, type MemeLibraryService } from "../skills/meme/library-service.js";
import type { MemeCandidateTracker } from "../skills/meme/candidate-tracker.js";

export interface CommandContext {
    bot: QQBot;
    message: NormalizedQqMessage;
    args: string;
    services?: CommandServices;
}

export interface CommandServices {
    isOwner(memberOpenid: string | undefined): boolean;
    memeCandidates: MemeCandidateTracker;
    memeLibrary: MemeLibraryService;
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
            const members = await getKnownMembers(message);
            const text = members.length > 0
                ? members.map((member) => member.username + " (" + (member.role ?? "member") + ")").join("\n")
                : "目前还不认识任何群友。";
            await bot.sendText(message.replyTarget, text);
        },
    },
    {
        name: "添加表情",
        description: "将最近发送的图片加入表情包库",
        async execute({ bot, message, args, services }) {
            if (!services?.isOwner(message.authorId)) {
                await bot.sendText(message.replyTarget, "无权限");
                return;
            }
            if (message.kind !== "group" || !message.groupId || !message.authorId) {
                await bot.sendText(message.replyTarget, "请在群聊中使用 /添加表情");
                return;
            }
            if (!args.trim()) {
                await bot.sendText(message.replyTarget, "用法：/添加表情 名称");
                return;
            }
            if (!services) throw new Error("Meme services are unavailable");

            if (message.source.refMsgIdx) {
                const quotedImage = message.quotedImages?.[0];
                let bytes: Buffer | undefined;
                const realMessageId = message.quotedMessage?.realMessageId;
                if (realMessageId) {
                    try {
                        bytes = await services.memeCandidates.readForMessage(message.groupId, realMessageId);
                    } catch { /* Try the quoted CDN URL if an exact local cache cannot be read. */ }
                }
                if (!bytes && !quotedImage) {
                    await bot.sendText(message.replyTarget, "引用的消息没有可添加的图片");
                    return;
                }
                try {
                    if (!bytes && quotedImage) bytes = await services.memeCandidates.downloadImage(quotedImage.url);
                } catch {
                    await bot.sendText(message.replyTarget, "引用的图片已失效或无法下载");
                    return;
                }

                try {
                    await services.memeLibrary.add(args.trim(), bytes!);
                    await bot.sendText(message.replyTarget, "已添加表情包");
                } catch (error) {
                    if (error instanceof MemeLibraryError) {
                        await bot.sendText(message.replyTarget, error.code === "duplicate" ? "表情包已存在"
                            : error.code === "invalid-name" ? "表情包名称无效"
                            : error.code === "unsupported-image" || error.code === "too-large" ? "表情处理失败"
                            : "添加表情包失败");
                        return;
                    }
                    throw error;
                }
                return;
            }

            const claim = await services.memeCandidates.claim(message.groupId, message.authorId);
            if (claim.kind === "missing") {
                await bot.sendText(message.replyTarget, "未找到你最近发送的表情包");
                return;
            }
            if (claim.kind === "busy") {
                await bot.sendText(message.replyTarget, "正在添加这张表情包，请稍后再试");
                return;
            }
            try {
                const bytes = await services.memeCandidates.read(claim.candidate);
                await services.memeLibrary.add(args.trim(), bytes);
                await services.memeCandidates.consume(claim.candidate);
                await bot.sendText(message.replyTarget, "已添加表情包");
            } catch (error) {
                services.memeCandidates.release(claim.candidate);
                if (error instanceof MemeLibraryError) {
                    await bot.sendText(message.replyTarget, error.code === "duplicate" ? "表情包已存在"
                        : error.code === "invalid-name" ? "表情包名称无效"
                        : error.code === "unsupported-image" || error.code === "too-large" ? "表情处理失败"
                        : "添加表情包失败");
                    return;
                }
                throw error;
            }
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
            const rendered = await renderMentions(message, "<mention>" + args + "</mention> 测试一下");
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
export async function routeCommand(bot: QQBot, message: NormalizedQqMessage, services?: CommandServices): Promise<boolean> {
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
        await command.execute({ bot, message, args: parsed.args, services });
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
