import type {
    QQBot,
    QQBotInboundMessage,
} from "@tencent-connect/qqbot-nodejs";

import { buildAiInput, buildReplyPolicy } from "../../ai/input-builder.js";
import { chat } from "../../ai/client.js";
import {
    buildChatInput,
    getRecentImages,
    rememberBotReply,
    rememberIncomingMessage,
} from "../conversation/recent-context.js";
import {
    isConversationActive,
    markConversationActive,
    stopConversation,
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

export function registerMessageHandler(bot: QQBot): void {
    bot.on("message", async (context, message: QQBotInboundMessage) => {
        const normalized = normalizeQqMessage(context, message);

        if (normalized.authorIsBot) {
            return;
        }

        // Remember the member before any content filters, as before.
        rememberKnownMember(normalized);

        const input = normalized.content;
        const imageAttachments = normalized.attachments.filter((attachment: any) => {
            const contentType = attachment?.content_type ?? attachment?.contentType;
            return typeof contentType === "string" && contentType.startsWith("image/");
        });
        const hasImages = imageAttachments.length > 0;

        console.log(
            "收到消息：",
            input || (hasImages ? `[图片 x${imageAttachments.length}]` : ""),
        );

        if (!input && !hasImages) {
            return;
        }

        if (isOnlyQQFace(input)) {
            console.log("[Filter] QQ 表情/表情包，忽略");
            return;
        }

        console.log(
            "[Message]",
            "kind =",
            normalized.kind,
            "event =",
            normalized.eventType,
        );

        const activeConversation =
            normalized.kind === "group" ||
            normalized.eventType === "GROUP_MESSAGE_CREATE" ||
            normalized.eventType === "GROUP_AT_MESSAGE_CREATE"
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
            console.log("[Trigger] 图片消息，仅记录上下文");
            return;
        }

        if (input === "/mc") {
            await sendMinecraftStatus(bot, normalized.replyTarget);
            return;
        }

        if (input === "/members") {
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
            const name = input.slice(4).trim();
            const rendered = renderMentions(
                normalized,
                `<mention>${name}</mention> 测试一下`,
            );
            await bot.sendMarkdown(normalized.replyTarget, rendered.sendText);
            return;
        }

        if (!trigger.shouldReply) {
            console.log("[Trigger] 普通群消息，仅记录上下文");
            return;
        }

        if (!userInput) {
            return;
        }

        console.log(
            "[Trigger]",
            trigger.isAtBot
                ? "@小尘：强制回复"
                : trigger.mentionedByName
                  ? "名字唤醒：AI 判断"
                  : trigger.activeConversation
                    ? "活跃对话：AI 判断"
                    : "私聊",
        );

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

        console.log("[AI] 当前消息：", userInput);
        console.log("[AI] 携带上下文：", chatInput !== userInput);
        console.log("[AI] 可选择沉默：", trigger.allowNoReply);
        console.log("[AI] 识图：", useVision, `图片数=${imageUrls.length}`);

        try {
            const reply = await chat(aiInput, {
                imageUrls,
                onWebSearchStart: async () => {
                    await bot.sendText(normalized.replyTarget, randomSearchNotice());
                },
            });

            if (reply.trim() === "<NO_REPLY>") {
                console.log("[AI] 判断无需回复，退出活跃对话");
                if (trigger.isGroup) {
                    stopConversation(normalized);
                }
                return;
            }

            const rendered = renderMentions(normalized, reply);
            await bot.sendMarkdown(normalized.replyTarget, rendered.sendText);
            rememberBotReply(normalized, rendered.contextText);

            if (trigger.isGroup) {
                markConversationActive(normalized);
            }
        } catch (error) {
            console.error("AI 请求失败：", error);
            await bot.sendText(normalized.replyTarget, "刚才脑子短路了一下。");
        }
    });
}
