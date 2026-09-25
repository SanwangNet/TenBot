import type {
    QQBot,
    QQBotInboundMessage,
} from "@tencent-connect/qqbot-nodejs";

import { buildAiInput, buildReplyPolicy } from "../../ai/input-builder.js";
import { routeCommand } from "../../commands/router.js";
import { projectMemeCandidates } from "../../skills/meme/projection.js";
import { getMemeRuntimeSnapshot, searchAutoMemeCandidates } from "../../skills/meme/skill.js";
import type { MemeSearchQuery } from "../../skills/meme/search.js";
import { debugPeerIdentity, logger, shortId, truncateLogText } from "../../shared/logger.js";
import {
    buildReplyCycleSnapshot,
    getConversationKey,
    getRecentImages,
    rememberIncomingMessage,
    recordIncomingMessageRevision,
} from "../conversation/recent-context.js";
import { isConversationActive } from "../conversation/engagement.js";
import {
    automatedPeerLoopGuard,
    type AutomatedPeerLoopGuard,
} from "../conversation/automated-peer.js";
import { buildKnownMembersContext, rememberKnownMember } from "../conversation/known-members.js";
import { normalizeQqMessage } from "../message/normalize-message.js";
import { decideMessageTrigger, isOnlyQQFace, wantsVision } from "../message/trigger.js";
import { coordinateAiReply } from "../reply/coordinator.js";

const SEARCH_NOTICES = [
    "\u7a0d\u7b49\uff0c\u6211\u67e5\u4e00\u4e0b\u3002",
    "\u6211\u641c\u4e00\u4e0b\u6700\u65b0\u7684\u3002",
    "\u8fd9\u4e2a\u5f97\u67e5\u4e00\u4e0b\uff0c\u6211\u770b\u770b\u3002",
    "\u6211\u53bb\u770b\u4e00\u773c\u73b0\u5728\u7684\u60c5\u51b5\u3002",
    "\u7b49\u6211\u7ffb\u4e00\u4e0b\u6700\u65b0\u8d44\u6599\u3002",
    "\u7a0d\u7b49\uff0c\u6211\u786e\u8ba4\u4e00\u4e0b\u3002",
];
function randomSearchNotice(): string {
    return SEARCH_NOTICES[Math.floor(Math.random() * SEARCH_NOTICES.length)];
}
function summarizeMessage(input: string, imageAttachments: any[]): string {
    if (isOnlyQQFace(input)) return "[QQ\u8868\u60c5]";
    if (input) return truncateLogText(input, 160);
    if (!imageAttachments.length) return "";
    const first = imageAttachments[0];
    if (first.width !== undefined && first.height !== undefined) {
        const dimensions = first.width + "x" + first.height;
        return imageAttachments.length === 1 ? "[\u56fe\u7247 " + dimensions + "]" : "[\u56fe\u7247 " + dimensions + " x" + imageAttachments.length + "]";
    }
    return "[\u56fe\u7247 x" + imageAttachments.length + "]";
}

export function registerMessageHandler(bot: QQBot, loopGuard: AutomatedPeerLoopGuard = automatedPeerLoopGuard): void {
    bot.on("message", async (context, message: QQBotInboundMessage) => {
        const normalized = await normalizeQqMessage(context, message);
        debugPeerIdentity(normalized.authorName, normalized.authorId);
        const isAutomatedPeer = loopGuard.isAutomatedPeer(normalized.authorId);
        // QQ's bot flag is not reliable membership policy; unregistered IDs fail open as human activity.

        const conversationKey = getConversationKey(normalized);
        if (isAutomatedPeer) loopGuard.observeAutomatedPeerMessage(conversationKey);
        else loopGuard.resetByHumanMessage(conversationKey, normalized.authorName);

        // Learn members and route native commands before they can affect an AI cycle.
        await rememberKnownMember(normalized);
        if (await routeCommand(bot, normalized)) return;

        const input = normalized.displayContent;
        const imageAttachments = normalized.attachments.filter((attachment: any) => {
            const contentType = attachment?.content_type ?? attachment?.contentType;
            return typeof contentType === "string" && contentType.startsWith("image/");
        });
        const hasImages = imageAttachments.length > 0;
        if (!input && !hasImages) return;
        if (isOnlyQQFace(input)) {
            logger.info("[Filter] qq-face");
            return;
        }

        const isGroupEvent = normalized.kind === "group" ||
            normalized.eventType === "GROUP_MESSAGE_CREATE" ||
            normalized.eventType === "GROUP_AT_MESSAGE_CREATE";
        const speaker = normalized.authorName
            ? truncateLogText(normalized.authorName, 60)
            : shortId(normalized.authorId);
        const messageSummary = summarizeMessage(input, imageAttachments);
        if (messageSummary) logger.info("[" + (isGroupEvent ? "GROUP" : "C2C") + "] " + speaker + ": " + messageSummary);
        else logger.debug("[QQ message] empty content");
        logger.debug("[QQ normalized]", {
            kind: normalized.kind,
            eventType: normalized.eventType,
            author: speaker,
            content: input,
            mentions: normalized.mentions.map((mention) => ({ isYou: mention.isSelf, name: mention.username })),
            attachments: imageAttachments.map((attachment: any) => ({
                contentType: attachment?.content_type ?? attachment?.contentType,
                width: attachment?.width,
                height: attachment?.height,
            })),
        });

        const activeConversation = isGroupEvent ? isConversationActive(normalized) : false;
        const trigger = decideMessageTrigger(normalized, activeConversation);
        const triggerPriority = !trigger.isGroup ? 3
            : trigger.isAtBot ? 3
              : trigger.mentionedByName ? 2
                : trigger.activeConversation ? 1 : 0;

        // Filtered QQ faces and local commands never increment revision or interrupt generation.
        const revision = recordIncomingMessageRevision(normalized);
        rememberIncomingMessage(normalized, input);
        logger.debug("[Cycle] inbound revision=" + revision);

        if (!input && hasImages) {
            const firstImage = imageAttachments[0];
            logger.info(firstImage.width !== undefined && firstImage.height !== undefined
                ? "[Image] cached " + firstImage.width + "x" + firstImage.height
                : "[Image] cached");
        }

        if (trigger.shouldReply && input) {
            const label = trigger.isAtBot ? "mention / hard"
                : trigger.mentionedByName ? "name / soft"
                  : trigger.activeConversation ? "active / soft" : "private";
            logger.info("[Trigger] " + label);
            logger.debug("[Trigger decision]", trigger);
        } else {
            logger.info("[Trigger] passive");
        }

        const latestMessage = normalized;
        await coordinateAiReply({
            bot,
            message: normalized,
            aiInput: "",
            imageUrls: [],
            isGroup: trigger.isGroup,
            allowNoReply: trigger.allowNoReply,
            triggerKind: trigger.triggerKind ?? undefined,
            messageRevision: revision,
            triggerPriority,
            isAtBot: trigger.isAtBot,
            mentionedByName: trigger.mentionedByName,
            shouldStartCycle: trigger.shouldReply && Boolean(input),
            onWebSearchStart: async () => {
                await bot.sendText(latestMessage.replyTarget, randomSearchNotice());
            },
            buildAttempt: async (attemptMessage, context) => {
                const memeSnapshot = getMemeRuntimeSnapshot();
                const snapshot = buildReplyCycleSnapshot(attemptMessage);
                const knownMembersContext = trigger.isGroup
                    ? await buildKnownMembersContext(attemptMessage)
                    : "";
                const memeQueries: MemeSearchQuery[] = [];
                const seenMemeRevisions = new Set<number>();
                for (const item of [
                    { anchor: context.effectiveAnchor, source: "anchor" as const },
                    ...context.newerMessages
                        .filter((item) => item.revision !== context.effectiveAnchor.revision)
                        .map((anchor) => ({ anchor, source: "new-message" as const })),
                ]) {
                    if (seenMemeRevisions.has(item.anchor.revision)) continue;
                    seenMemeRevisions.add(item.anchor.revision);
                    const text = item.anchor.message.displayContent.trim();
                    if (text) memeQueries.push({ text, source: item.source });
                }
                const memeCandidates = searchAutoMemeCandidates(memeQueries, undefined, memeSnapshot);
                const memeContext = projectMemeCandidates(memeCandidates);
                if (memeCandidates.length) {
                    const top = truncateLogText(memeCandidates[0].entry.name, 64);
                    logger.info(`[Meme] candidates=${memeCandidates.length} top=${JSON.stringify(top)}`);
                    memeCandidates.forEach((candidate, index) => {
                        logger.debug(`[Meme] #${index + 1} name=${JSON.stringify(truncateLogText(candidate.entry.name, 64))}` +
                            ` score=${candidate.score} strength=${candidate.strength.toLowerCase()}` +
                            ` source=${(candidate.matchedBy ?? []).join(",")}`);
                    });
                }
                const replyPolicy = buildReplyPolicy(context.allowNoReply);
                const aiInput = buildAiInput(snapshot.text, knownMembersContext, replyPolicy, memeContext);
                const recentImageUrls = getRecentImages(attemptMessage, 1);
                const useVision = wantsVision(
                    attemptMessage.displayContent,
                    context.isAtBot,
                    context.mentionedByName,
                    recentImageUrls.length > 0,
                );
                return { aiInput, imageUrls: useVision ? recentImageUrls : [], refs: snapshot.refs, memeSnapshot };
            },
        }, { botLoopGuard: loopGuard });
    });
}
