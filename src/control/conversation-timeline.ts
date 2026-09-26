import type { NormalizedQqMessage } from "../qq/message/normalize-message.js";
import { getConversationKey } from "../qq/conversation/recent-context.js";
import { truncateLogText } from "../shared/logger.js";
import { toConversationIdentity, type ConversationKind } from "./conversation-identity.js";

export type ConversationItem =
    | { id: string; type: "peer-message"; displayName: string; content: string; timestamp: string }
    | { id: string; type: "ai-attempt"; cycleId: string; attemptId: string; timestamp: string; status: "generating" | "interrupted" | "completed" | "failed"; failureStage?: "generation" | "send" }
    | { id: string; type: "ai-reply"; content: string; timestamp: string; sendStatus: "sent" };

export interface ConversationSummary {
    conversationId: string;
    kind: ConversationKind;
    label: string;
    lastActivityAt: string;
}

export type ConversationRuntimeEvent = {
    type: "conversation-item";
    conversationId: string;
    kind: ConversationKind;
    label: string;
    item: ConversationItem;
};

interface ConversationRecord extends ConversationSummary {
    items: ConversationItem[];
}

/** Process-local, bounded UI timeline. It contains no transport IDs or conversation keys. */
export class ConversationTimelineStore {
    private readonly conversations = new Map<string, ConversationRecord>();

    constructor(private readonly maxConversations = 20, private readonly maxItems = 100) {}

    append(event: ConversationRuntimeEvent): void {
        if (event.item.type === "ai-attempt" && event.item.status === "completed") {
            const record = this.conversations.get(event.conversationId);
            const attemptId = event.item.attemptId;
            const existing = record?.items.findIndex((item) => item.type === "ai-attempt" && item.attemptId === attemptId) ?? -1;
            if (record && existing >= 0) record.items.splice(existing, 1);
            return;
        }
        let record = this.conversations.get(event.conversationId);
        if (!record) record = { conversationId: event.conversationId, kind: event.kind, label: event.label, lastActivityAt: event.item.timestamp, items: [] };
        record.kind = event.kind;
        record.label = event.label;
        record.lastActivityAt = event.item.timestamp;
        if (event.item.type === "ai-attempt") {
            const attemptId = event.item.attemptId;
            const existing = record.items.findIndex((item) => item.type === "ai-attempt" && item.attemptId === attemptId);
            if (existing >= 0) {
                const previous = record.items[existing];
                record.items[existing] = structuredClone({ ...event.item, timestamp: previous?.timestamp ?? event.item.timestamp });
            }
            else record.items.push(structuredClone(event.item));
        } else record.items.push(structuredClone(event.item));
        if (record.items.length > this.maxItems) record.items.splice(0, record.items.length - this.maxItems);
        this.conversations.delete(event.conversationId);
        this.conversations.set(event.conversationId, record);
        while (this.conversations.size > this.maxConversations) {
            const oldest = this.conversations.keys().next().value as string | undefined;
            if (oldest === undefined) break;
            this.conversations.delete(oldest);
        }
    }

    list(): ConversationSummary[] {
        return [...this.conversations.values()].reverse().map(({ conversationId, kind, label, lastActivityAt }) => ({ conversationId, kind, label, lastActivityAt }));
    }

    get(conversationId: string): ConversationItem[] {
        return this.conversations.get(conversationId)?.items.map((item) => structuredClone(item)) ?? [];
    }
}

/** Builds a display-safe peer item using the same conversation key as Reply Cycle. */
export function createIncomingConversationEvent(message: NormalizedQqMessage, itemId: string): ConversationRuntimeEvent {
    const identity = toConversationIdentity(getConversationKey(message));
    const parsed = message.timestamp ? Date.parse(message.timestamp) : Number.NaN;
    return {
        type: "conversation-item",
        conversationId: identity.conversationId,
        kind: identity.kind,
        label: identity.label,
        item: {
            id: itemId,
            type: "peer-message",
            displayName: truncateLogText(message.authorName || (identity.kind === "group" ? "群友" : "对方"), 60),
            content: truncateLogText(message.displayContent, 2000),
            timestamp: Number.isNaN(parsed) ? new Date().toISOString() : new Date(parsed).toISOString(),
        },
    };
}
