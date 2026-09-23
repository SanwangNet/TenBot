import type { QQBotInboundMessage } from "@tencent-connect/qqbot-nodejs";

export interface NormalizedQqMessage {
    /** Original SDK object, retained for SDK send helpers and unmodelled fields. */
    source: QQBotInboundMessage;
    id?: string;
    kind: QQBotInboundMessage["kind"];
    eventType: string;
    content: string;
    groupId?: string;
    author: any;
    authorId?: string;
    authorName?: string;
    authorIsBot: boolean;
    mentions: any[];
    attachments: any[];
    replyTarget: QQBotInboundMessage["replyTarget"];
    timestamp?: string;
    raw: any;
}

/** Collapse the SDK's convenience and raw fields at the QQ boundary. */
export function normalizeQqMessage(
    context: unknown,
    message: QQBotInboundMessage,
): NormalizedQqMessage {
    const contextEventType =
        (context as { eventType?: string } | null)?.eventType;
    const raw = message.raw as any;
    const author = (message as any).author ?? raw?.author ?? null;
    const mentions = Array.isArray(message.mentions)
        ? message.mentions
        : Array.isArray(raw?.mentions)
          ? raw.mentions
          : [];
    const attachments = Array.isArray(message.attachments)
        ? message.attachments
        : Array.isArray(raw?.attachments)
          ? raw.attachments
          : [];

    return {
        source: message,
        id: message.messageId,
        kind: message.kind,
        eventType: message.rawEventType ?? contextEventType ?? "",
        content: message.content?.trim?.() ?? "",
        groupId:
            (message as any).replyTarget?.targetId ??
            message.groupOpenid ??
            (message as any).groupId ??
            raw?.group_openid ??
            raw?.group_id,
        author,
        authorId: author?.id ?? raw?.author?.id,
        authorName:
            author?.username ??
            raw?.author?.username ??
            author?.nickname ??
            raw?.author?.nickname,
        authorIsBot:
            (message as any).author?.bot === true ||
            raw?.author?.bot === true,
        mentions,
        attachments,
        replyTarget: message.replyTarget,
        timestamp: message.timestamp ?? raw?.timestamp,
        raw,
    };
}
