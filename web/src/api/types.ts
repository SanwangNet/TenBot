export type QqConnectionState = "connecting" | "connected" | "disconnected" | "error";

export interface RuntimeStatus {
    qq: QqConnectionState;
    provider: {
        id: "gpt" | "deepseek";
        model: string;
        webSearch: boolean;
        configured: boolean;
        reasoningEffort?: string;
        verbosity?: string;
    };
    activeCycles: number;
    contextConversations: number;
    runtimeConfig?: { logLevel: string; botLoopGuardMaxCycles: number };
    hotReload?: {
        enabled: boolean;
        revision: number;
        loadedAt: string;
        lastSuccessAt: string;
        lastFailure?: { message: string; timestamp: string };
        requiresRestart: boolean;
    };
    memes: { count: number; revision: number; loadedAt: string };
    prompt: {
        provider: "gpt" | "deepseek";
        revision: number;
        loadedAt: string;
        characters?: number;
        lines?: number;
    };
    shuttingDown: boolean;
}

export interface PublicConfig {
    aiProvider: "gpt" | "deepseek";
    replyJudge: { model: string; timeoutMs: number };
    gpt: { model: string; reasoningEffort: string; verbosity: string; configured: boolean };
    deepseek: { model: string; reasoningEffort: string; configured: boolean };
    logLevel: string;
    botLoopGuard: { maxCycles: number; automatedPeerCount: number };
}

export interface ConversationSummary {
    conversationId: string;
    kind: "group" | "c2c" | "dm";
    label: string;
    lastActivityAt: string;
}

export interface ConversationItem {
    id: string;
    type: "peer-message" | "ai-attempt" | "ai-reply";
    timestamp: string;
    [key: string]: unknown;
}

export interface AutomatedPeerSummary {
    id: string;
    displayId: string;
    displayName: string;
    platformBotHint: boolean;
    lastSeenAt?: string;
}

export interface KnownMemberSummary {
    id: string;
    displayId: string;
    displayName: string;
    lastSeenAt: number;
    groupCount: number;
    roles?: string[];
}

export interface LogEntry {
    timestamp: string;
    level: "info" | "debug" | "error";
    text: string;
}

export type RuntimeEvent =
    | { type: "provider-error"; notice: { message: string; [key: string]: unknown } }
    | { type: "recent-peers-updated" }
    | { type: "reload-failure"; target: "config" | "prompt" | "memes"; message: string; timestamp: string }
    | { type: "conversation-item"; conversationId: string; kind: string; label: string; item: ConversationItem };
