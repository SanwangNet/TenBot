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
    replyJudge: { model: string; timeoutMs: number; provider?: string };
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
    kind: "group" | "private";
    label: string;
    lastActivityAt: string;
}

export type ConversationItem =
    | { id: string; type: "peer-message"; displayName: string; content: string; timestamp: string }
    | { id: string; type: "ai-attempt"; cycleId: string; attemptId: string; timestamp: string; status: "generating" | "interrupted" | "completed" | "failed"; failureStage?: "generation" | "send" }
    | { id: string; type: "ai-reply"; content: string; timestamp: string; sendStatus: "sent" };

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

export interface ProviderErrorNotice {
    provider: string;
    model: string;
    tenbotCode: string;
    status?: number;
    code?: string;
    retryable?: boolean;
    message: string;
    details?: string;
    timestamp: string;
}

export type EditorResourceId = "prompt:gpt" | "prompt:deepseek" | "prompt:reply-judge" | "meme:data";
export interface EditorResource {
    id: EditorResourceId;
    displayName: string;
    language: "markdown" | "json";
    content: string;
    version: string;
}
export interface ReloadResult { ok: boolean; message: string; revision?: number; count?: number; loadedAt?: string }
export interface EditorSaveResponse { ok: true; resource: EditorResource; reload: ReloadResult }
export interface AutomatedPeerMutationResult { ok: boolean; changed: boolean; message: string; details?: string }

export type RuntimeEvent =
    | { type: "provider-error"; notice: ProviderErrorNotice }
    | { type: "recent-peers-updated" }
    | { type: "reload-failure"; target: "config" | "prompt" | "memes"; message: string; timestamp: string }
    | { type: "conversation-item"; conversationId: string; kind: ConversationSummary["kind"]; label: string; item: ConversationItem };
