import type {
    QQBot,
    QQBotInboundMessage,
} from "@tencent-connect/qqbot-nodejs";

import { buildAiInput, buildReplyPolicy } from "../../ai/input-builder.js";
import { logger, shortId, truncateLogText } from "../../shared/logger.js";
import {
    buildChatInput,
    getRecentImages,
    rememberIncomingMessage,
    recordIncomingMessageRevision,
} from "../conversation/recent-context.js";
import {
    isConversationActive,
} from "../conversation/engagement.js";
import {
    buildKnownMembersContext,
    getKnownMembers,
    rememberKnownMember,
    renderMentions,
} from "../conversation/known-members.js";
import { normalizeQqMessage } from "../message/normalize-message.js";
import { decideMessageTrigger, isOnlyQQFace, wantsVision } from "../message/trigger.js";
import { sendMinecraftStatus } from "../minecraft-status.js";
import { coordinateAiReply } from "../reply/coordinator.js";

const SEARCH_NOTICES = [
    "稍等，我查一下。",
    "我搜一下最新的。",
    "这个得查一下，我看看。",
    "我去看一眼现在的情况。",
    "等我翻一下最新资料。",
    "稍等，我确认一下。",
];

function randomSearchNotice(): string {
    return SEARCH_NOTICES[
        Math.floor(Math.random() * SEARCH_NOTICES.length)
    ];
}

function summarizeMessage(
    input: string,
    imageAttachments: any[],
): string {
    if (isOnlyQQFace(input)) {
        return "[QQ表情]";
    }
    if (input) {
        return truncateLogText(input, 160);
    }
    if (imageAttachments.length === 0) {
        return "";
    }

    const firstImage = imageAttachments[0];
    if (firstImage.width !== undefined && firstImage.height !== undefined) {
        const dimensions = `${firstImage.width}x${firstImage.height}`;
        return imageAttachments.length === 1
            ? `[图片 ${dimensions}]`
            : `[图片 ${dimensions} x${imageAttachments.length}]`;
    }
    return `[图片 x${imageAttachments.length}]`;
}

export function registerMessageHandler(bot: QQBot): void {
    bot.on("message", async (context, message: QQBotInboundMessage) => {
        const normalized = normalizeQqMessage(context, message);

        if (normalized.authorIsBot) {
            return;
        }

        recordIncomingMessageRevision(normalized);

        // Keep learning members before the existing content filters.
        rememberKnownMember(normalized);

        const input = normalized.content;
        const imageAttachments = normalized.attachments.filter((attachment: any) => {
            const contentType = attachment?.content_type ?? attachment?.contentType;
            return typeof contentType === "string" && contentType.startsWith("image/");
        });
        const hasImages = imageAttachments.length > 0;
        const isGroupEvent =
            normalized.kind === "group" ||
            normalized.eventType === "GROUP_MESSAGE_CREATE" ||
            normalized.eventType === "GROUP_AT_MESSAGE_CREATE";
        const speaker = normalized.authorName
            ? truncateLogText(normalized.authorName, 60)
            : shortId(normalized.authorId);
        const messageSummary = summarizeMessage(input, imageAttachments);

        if (messageSummary) {
            logger.info(`[${isGroupEvent ? "GROUP" : "C2C"}] ${speaker}: ${messageSummary}`);
        } else {
            logger.debug("[QQ message] empty content");
        }

        logger.debug("[QQ normalized]", {
            kind: normalized.kind,
            eventType: normalized.eventType,
            author: speaker,
            content: input,
            mentions: normalized.mentions.map((mention: any) => ({
                isYou: mention?.is_you ?? mention?.isYou,
                name: mention?.username ?? mention?.name,
            })),
            attachments: imageAttachments.map((attachment: any) => ({
                contentType: attachment?.content_type ?? attachment?.contentType,
                width: attachment?.width,
                height: attachment?.height,
            })),
        });

        if (!input && !hasImages) {
            return;
        }

        if (isOnlyQQFace(input)) {
            logger.info("[Filter] qq-face");
            return;
        }

        const activeConversation = isGroupEvent
            ? isConversationActive(normalized)
            : false;
        const trigger = decideMessageTrigger(normalized, activeConversation);
        const userInput = input.startsWith("/ai ") ? input.slice(4).trim() : input;

        // Build history before appending this message so it is not duplicated.
        const chatInput =
            trigger.shouldReply && userInput
                ? buildChatInput(normalized, userInput)
                : userInput;

        rememberIncomingMessage(normalized, input);

        if (!input && hasImages) {
            const firstImage = imageAttachments[0];
            logger.info(
                firstImage.width !== undefined && firstImage.height !== undefined
                    ? `[Image] cached ${firstImage.width}x${firstImage.height}`
                    : "[Image] cached",
            );
            logger.info("[Trigger] passive");
            return;
        }

        if (input === "/mc") {
            logger.info("[Trigger] command /mc");
            await sendMinecraftStatus(bot, normalized.replyTarget);
            return;
        }

        if (input === "/members") {
            logger.info("[Trigger] command /members");
            const members = getKnownMembers(normalized);
            const text =
                members.length > 0
                    ? members
                          .map((member) => `${member.username} (${member.role ?? "member"})`)
                          .join("\n")
                    : "目前还不认识任何群友。";
            await bot.sendText(normalized.replyTarget, text);
            return;
        }

        if (input.startsWith("/at ")) {
            logger.info("[Trigger] command /at");
            const name = input.slice(4).trim();
            const rendered = renderMentions(
                normalized,
                `<mention>${name}</mention> 测试一下`,
            );
            await bot.sendMarkdown(normalized.replyTarget, rendered.sendText);
            return;
        }

        if (!trigger.shouldReply) {
            logger.info("[Trigger] passive");
            return;
        }

        if (!userInput) {
            return;
        }

        const triggerLabel = trigger.isAtBot
            ? "mention / hard"
            : trigger.mentionedByName
              ? "name / soft"
              : trigger.activeConversation
                ? "active / soft"
                : "private";
        logger.info(`[Trigger] ${triggerLabel}`);
        logger.debug("[Trigger decision]", trigger);

        const replyPolicy = buildReplyPolicy(trigger.allowNoReply);
        const knownMembersContext = trigger.isGroup
            ? buildKnownMembersContext(normalized)
            : "";
        const aiInput = buildAiInput(chatInput, knownMembersContext, replyPolicy);

        // The current message is already cached; this can also select its image.
        const recentImageUrls = getRecentImages(normalized, 1);
        const useVision = wantsVision(
            userInput,
            trigger.isAtBot,
            trigger.mentionedByName,
            recentImageUrls.length > 0,
        );
        const imageUrls = useVision ? recentImageUrls : [];

        logger.debug("[AI reply policy]", replyPolicy);
        await coordinateAiReply({
            bot,
            message: normalized,
            aiInput,
            imageUrls,
            isGroup: trigger.isGroup,
            allowNoReply: trigger.allowNoReply,
            onWebSearchStart: async () => {
                await bot.sendText(normalized.replyTarget, randomSearchNotice());
            },
        });
    });
}
