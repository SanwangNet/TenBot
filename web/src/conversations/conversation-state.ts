import type { ConversationItem, ConversationSummary, RuntimeEvent } from "../api/types.js";

export interface ConversationViewState {
    summaries: ConversationSummary[];
    timelines: Record<string, ConversationItem[]>;
    revision: number;
}
export const initialConversationViewState: ConversationViewState = { summaries: [], timelines: {}, revision: 0 };
export type ConversationAction =
    | { type: "list"; summaries: ConversationSummary[] }
    | { type: "timeline"; id: string; items: ConversationItem[]; atRevision: number }
    | { type: "event"; event: Extract<RuntimeEvent, { type: "conversation-item" }> };

export function conversationReducer(state: ConversationViewState, action: ConversationAction): ConversationViewState {
    if (action.type === "list") return { ...state, summaries: action.summaries };
    if (action.type === "timeline") {
        if (action.atRevision !== state.revision) return state;
        return { ...state, timelines: { ...state.timelines, [action.id]: action.items } };
    }
    const { event } = action;
    const existing = state.timelines[event.conversationId];
    if (event.item.type === "ai-attempt" && event.item.status === "completed") {
        if (!existing) return state;
        const completedAttemptId = event.item.attemptId;
        return {
            ...state,
            timelines: { ...state.timelines, [event.conversationId]: existing.filter((item) => item.type !== "ai-attempt" || item.attemptId !== completedAttemptId) },
            revision: state.revision + 1,
        };
    }
    let items = existing ? [...existing] : undefined;
    if (items && event.item.type === "ai-attempt") {
        const attemptId = event.item.attemptId;
        const index = items.findIndex((item) => item.type === "ai-attempt" && item.attemptId === attemptId);
        if (index >= 0) items[index] = { ...event.item, timestamp: items[index]!.timestamp };
        else items.push(event.item);
    } else if (items) items.push(event.item);
    if (items && items.length > 100) items = items.slice(-100);
    const summary: ConversationSummary = { conversationId: event.conversationId, kind: event.kind, label: event.label, lastActivityAt: event.item.timestamp };
    return {
        summaries: [summary, ...state.summaries.filter((item) => item.conversationId !== event.conversationId)].slice(0, 20),
        timelines: items ? { ...state.timelines, [event.conversationId]: items } : state.timelines,
        revision: state.revision + 1,
    };
}
