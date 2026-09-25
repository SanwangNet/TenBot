import type { PromptProvider } from "../ai/prompt-store.js";
import type { ConfigUpdateResult, PublicConfig, PublicConfigPatch } from "../config/config-types.js";
import type { LogEntry, LogListener } from "../shared/logger.js";
import type { RuntimeEvent, RuntimeEventListener } from "./runtime-event.js";
import type { RuntimeStatus } from "./runtime-status.js";
import type { AutomatedPeerMutationResult, AutomatedPeerSummary } from "./automated-peers.js";
import { ConversationTimelineStore, type ConversationSummary, type ConversationItem } from "./conversation-timeline.js";

export const MAX_TUI_LOG_ENTRIES = 400;

export type ReloadResult =
    | { ok: true; message: string; loadedAt: string; revision?: number; count?: number }
    | { ok: false; message: string; details?: string };

export type StatusListener = (status: RuntimeStatus) => void;

export interface TenBotControl {
    getStatus(): RuntimeStatus;
    getConfig(): PublicConfig;
    updateConfig(patch: PublicConfigPatch): Promise<ConfigUpdateResult>;
    getAutomatedPeers(): AutomatedPeerSummary[];
    getRecentPeers(): AutomatedPeerSummary[];
    getConversations(): ConversationSummary[];
    getConversationTimeline(conversationId: string): ConversationItem[];
    addAutomatedPeer(id: string): Promise<AutomatedPeerMutationResult>;
    removeAutomatedPeer(id: string): Promise<AutomatedPeerMutationResult>;
    subscribeStatus(listener: StatusListener): () => void;
    subscribeLogs(listener: LogListener): () => void;
    subscribeEvents(listener: RuntimeEventListener): () => void;
    reloadPrompt(provider?: PromptProvider): Promise<ReloadResult>;
    reloadMemes(): Promise<ReloadResult>;
    shutdown(): Promise<void>;
}

export interface TenBotControlOperations {
    getStatus(): RuntimeStatus;
    getConfig(): PublicConfig;
    updateConfig(patch: PublicConfigPatch): Promise<ConfigUpdateResult>;
    getAutomatedPeers(): AutomatedPeerSummary[];
    getRecentPeers(): AutomatedPeerSummary[];
    addAutomatedPeer(id: string): Promise<AutomatedPeerMutationResult>;
    removeAutomatedPeer(id: string): Promise<AutomatedPeerMutationResult>;
    reloadPrompt(provider?: PromptProvider): Promise<ReloadResult>;
    reloadMemes(): Promise<ReloadResult>;
    shutdown(): Promise<void>;
    subscribeLogs(listener: LogListener): () => void;
}

/** Keeps UI-facing data and operations separate from Runtime implementation objects. */
export function createTenBotControl(operations: TenBotControlOperations): TenBotControl & {
    publishStatus(): void;
    publishEvent(event: RuntimeEvent): void;
} {
    const statusListeners = new Set<StatusListener>();
    const eventListeners = new Set<RuntimeEventListener>();
    const conversations = new ConversationTimelineStore();
    const getStatus = (): RuntimeStatus => structuredClone(operations.getStatus());

    return {
        getStatus,
        getConfig: () => structuredClone(operations.getConfig()),
        updateConfig: (patch) => operations.updateConfig(patch),
        getAutomatedPeers: () => structuredClone(operations.getAutomatedPeers()),
        getRecentPeers: () => structuredClone(operations.getRecentPeers()),
        getConversations: () => conversations.list(),
        getConversationTimeline: (conversationId) => conversations.get(conversationId),
        addAutomatedPeer: (id) => operations.addAutomatedPeer(id),
        removeAutomatedPeer: (id) => operations.removeAutomatedPeer(id),
        subscribeStatus(listener) {
            statusListeners.add(listener);
            listener(getStatus());
            return () => statusListeners.delete(listener);
        },
        subscribeLogs: (listener) => operations.subscribeLogs(listener),
        subscribeEvents(listener) {
            eventListeners.add(listener);
            return () => eventListeners.delete(listener);
        },
        async reloadPrompt(provider) {
            const result = await operations.reloadPrompt(provider);
            this.publishStatus();
            return result;
        },
        async reloadMemes() {
            const result = await operations.reloadMemes();
            this.publishStatus();
            return result;
        },
        shutdown: () => operations.shutdown(),
        publishStatus() {
            const status = getStatus();
            for (const listener of statusListeners) {
                try { listener(status); } catch { /* UI listeners cannot block Runtime work. */ }
            }
        },
        publishEvent(event: RuntimeEvent) {
            if (event.type === "conversation-item") conversations.append(event);
            for (const listener of eventListeners) {
                try { listener(structuredClone(event)); } catch { /* UI listeners cannot block Runtime work. */ }
            }
        },
    };
}
