export type ConversationItem =
    | { id: string; type: "group-message"; displayName: string; content: string; timestamp: string }
    | { id: string; type: "ai-attempt"; cycleId: string; attemptId: string; timestamp: string; status: "generating" | "interrupted" | "completed" | "failed"; failureStage?: "generation" | "send" }
    | { id: string; type: "ai-reply"; content: string; timestamp: string; sendStatus: "sent" };

export interface ConversationSummary {
    conversationId: string;
    label: string;
    lastActivityAt: string;
}

export type ConversationRuntimeEvent = {
    type: "conversation-item";
    conversationId: string;
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
        let record = this.conversations.get(event.conversationId);
        if (!record) record = { conversationId: event.conversationId, label: event.label, lastActivityAt: event.item.timestamp, items: [] };
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
        return [...this.conversations.values()].reverse().map(({ conversationId, label, lastActivityAt }) => ({ conversationId, label, lastActivityAt }));
    }

    get(conversationId: string): ConversationItem[] {
        return this.conversations.get(conversationId)?.items.map((item) => structuredClone(item)) ?? [];
    }
}
