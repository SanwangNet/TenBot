import type { MiddlewareContext, QQBotInboundMessage, ResolvedQuote } from "@tencent-connect/qqbot-nodejs";
import { getKnownMemberNameById } from "../conversation/known-members.js";
import { findRecentQuotedMessage } from "../conversation/recent-context.js";
import { logger } from "../../shared/logger.js";

export interface QuotedMessage {
    authorName?: string;
    content?: string;
    realMessageId?: string;
}

export interface NormalizedMention {
    memberOpenid?: string;
    ids: string[];
    username?: string;
    role?: string;
    isBot: boolean;
    isSelf: boolean;
}

export interface NormalizedQqMessage {
    source: QQBotInboundMessage;
    id?: string;
    kind: QQBotInboundMessage["kind"];
    eventType: string;
    content: string;
    displayContent: string;
    groupId?: string;
    author: any;
    authorId?: string;
    authorName?: string;
    authorIsBot: boolean;
    mentions: NormalizedMention[];
    attachments: any[];
    replyTarget: QQBotInboundMessage["replyTarget"];
    timestamp?: string;
    raw: any;
    quotedMessage?: QuotedMessage;
    quotedBot?: boolean;
}

function stringField(value: unknown): string | undefined {
    return typeof value === "string" && value ? value : undefined;
}

function normalizeMentions(rawMentions: unknown): NormalizedMention[] {
    if (!Array.isArray(rawMentions)) return [];
    return rawMentions.filter((value) => value && typeof value === "object").map((raw) => {
        const ids = [
            stringField(raw.member_openid ?? raw.memberOpenid),
            stringField(raw.user_openid ?? raw.userOpenid),
            stringField(raw.id),
        ].filter((value): value is string => Boolean(value));
        return {
            memberOpenid: stringField(raw.member_openid ?? raw.memberOpenid ?? raw.id),
            ids: [...new Set(ids)],
            username: stringField(raw.username ?? raw.nickname ?? raw.name),
            role: stringField(raw.member_role ?? raw.memberRole),
            isBot: raw.bot === true,
            isSelf: raw.is_you === true || raw.isYou === true,
        };
    });
}

/** Only readable names enter AI input or recent context. Unknown IDs never do. */
export async function resolveDisplayContent(
    content: string,
    mentions: NormalizedMention[],
    groupId?: string,
): Promise<string> {
    const matches = [...content.matchAll(/<@([^<>\s]+)>/g)];
    const names = await Promise.all(matches.map(async (match) => {
        const rawId = match[1];
        const id = rawId.startsWith("!") ? rawId.slice(1) : rawId;
        const current = mentions.find((mention) => mention.ids.includes(id));
        const name = current?.username ?? await getKnownMemberNameById(groupId, id);
        return "@" + (name || "未知成员");
    }));
    let cursor = 0;
    let rendered = "";
    for (const [index, match] of matches.entries()) {
        rendered += content.slice(cursor, match.index) + names[index];
        cursor = match.index! + match[0].length;
    }
    return rendered + content.slice(cursor);
}

export async function normalizeQqMessage(
    context: unknown,
    message: QQBotInboundMessage,
): Promise<NormalizedQqMessage> {
    const contextEventType = (context as { eventType?: string } | null)?.eventType;
    const raw = message.raw as any;
    const author = (message as any).author ?? raw?.author ?? null;
    const mentions = normalizeMentions(
        Array.isArray(message.mentions) ? message.mentions : raw?.mentions,
    );
    const attachments = Array.isArray(message.attachments)
        ? message.attachments
        : Array.isArray(raw?.attachments) ? raw.attachments : [];
    const groupId = message.kind === "group"
        ? message.groupOpenid ?? (message as any).groupId ??
          raw?.group_openid ?? raw?.group_id ?? message.replyTarget?.targetId
        : undefined;
    const content = message.content?.trim?.() ?? "";
    const normalized: NormalizedQqMessage = {
        source: message,
        id: message.messageId,
        kind: message.kind,
        eventType: message.rawEventType ?? contextEventType ?? "",
        content,
        displayContent: await resolveDisplayContent(content, mentions, groupId),
        groupId,
        author,
        // The SDK maps QQ's stable member OpenID into senderId as well. Never
        // infer a peer identity from display fields or an untyped author.id.
        authorId: message.kind === "group"
            ? stringField(author?.member_openid ?? author?.memberOpenid) ?? stringField(message.senderId)
            : stringField(author?.user_openid ?? author?.userOpenid) ?? stringField(message.senderId),
        authorName: author?.username ?? raw?.author?.username ??
            author?.nickname ?? raw?.author?.nickname ?? message.senderName,
        authorIsBot: message.senderIsBot === true ||
            author?.bot === true || raw?.author?.bot === true,
        mentions,
        attachments,
        replyTarget: message.replyTarget,
        timestamp: message.timestamp ?? raw?.timestamp,
        raw,
        quotedBot: false,
    };
    if (message.refMsgIdx) {
        const recent = findRecentQuotedMessage(normalized, message.refMsgIdx);
        const resolved = (context as MiddlewareContext | null)?.state?.quote as ResolvedQuote | undefined;
        const quotedElement = message.msgElements?.[0];
        const attachments = resolved?.attachments ?? quotedElement?.attachments?.map((attachment) => ({
            contentType: attachment.content_type,
        })) ?? [];
        const media = attachments.map((attachment) => {
            const type = attachment.contentType.toLowerCase();
            if (type.startsWith("image/")) return "[图片]";
            if (type.startsWith("audio/")) return "[语音]";
            if (type.startsWith("video/")) return "[视频]";
            return "[文件]";
        });
        const fallbackText = [quotedElement?.content ?? resolved?.rawContent ?? resolved?.entry?.content ?? "", ...media]
            .filter(Boolean).join(" ");
        const content = recent?.content ?? (fallbackText
            ? await resolveDisplayContent(fallbackText, [], groupId) : undefined);
        normalized.quotedMessage = {
            authorName: recent?.authorName ?? resolved?.entry?.senderName,
            content,
            realMessageId: recent?.id ?? (resolved?.entry?.messageId || undefined),
        };
        normalized.quotedBot = recent?.isBotReply === true;
        if (content) logger.debug("[Quote] resolved inbound reference");
        else logger.debug("[Quote] inbound reference unresolved");
    }
    return normalized;
}
