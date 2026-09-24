import type { QQBotInboundMessage } from "@tencent-connect/qqbot-nodejs";
import { getKnownMemberNameById } from "../conversation/known-members.js";

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
    return {
        source: message,
        id: message.messageId,
        kind: message.kind,
        eventType: message.rawEventType ?? contextEventType ?? "",
        content,
        displayContent: await resolveDisplayContent(content, mentions, groupId),
        groupId,
        author,
        authorId: author?.id ?? author?.member_openid ?? author?.user_openid ?? message.senderId,
        authorName: author?.username ?? raw?.author?.username ??
            author?.nickname ?? raw?.author?.nickname ?? message.senderName,
        authorIsBot: message.senderIsBot === true ||
            author?.bot === true || raw?.author?.bot === true,
        mentions,
        attachments,
        replyTarget: message.replyTarget,
        timestamp: message.timestamp ?? raw?.timestamp,
        raw,
    };
}
