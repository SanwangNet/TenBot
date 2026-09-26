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

export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh";
export type ModelVerbosity = "low" | "medium" | "high";
export type LogLevel = "debug" | "info" | "error";

export interface PublicConfig {
    aiProvider: "gpt" | "deepseek";
    replyJudge: { model: string; timeoutMs: number };
    gpt: { model: string; reasoningEffort: ReasoningEffort; verbosity: ModelVerbosity; configured: boolean };
    deepseek: { model: string; reasoningEffort: ReasoningEffort; configured: boolean };
    logLevel: LogLevel;
    botLoopGuard: { maxCycles: number; automatedPeerCount: number };
}

export type PublicConfigPatch =
    | { field: "aiProvider"; value: "gpt" | "deepseek" }
    | { field: "gpt.model"; value: string }
    | { field: "gpt.reasoningEffort"; value: ReasoningEffort }
    | { field: "gpt.verbosity"; value: ModelVerbosity }
    | { field: "deepseek.model"; value: string }
    | { field: "deepseek.reasoningEffort"; value: ReasoningEffort }
    | { field: "replyJudge.model"; value: string }
    | { field: "replyJudge.timeoutMs"; value: number }
    | { field: "logLevel"; value: LogLevel }
    | { field: "botLoopGuard.maxCycles"; value: number };

export type ConfigUpdateResult =
    | { ok: true; requiresRestart: boolean; changedFields: string[]; message: string }
    | { ok: false; requiresRestart: false; changedFields: string[]; message: string; details?: string };

export interface ConfigPatchResponse {
    result: Extract<ConfigUpdateResult, { ok: true }>;
    config: PublicConfig;
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
