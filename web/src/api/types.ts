import type { GptModelSummary } from "../../../src/ai/model-classification.js";

export type QqConnectionState = "connecting" | "connected" | "disconnected" | "error";

export interface AuthMeResponse {
    authenticated: true;
    user: { id: string; login: string; avatarUrl: string | null };
}

export interface RuntimeStatus {
    qq: QqConnectionState;
    groupRepliesEnabled: boolean;
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
    runtimeConfig?: { botLoopGuardMaxCycles: number };
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
export type ImageGenerationQuality = "low" | "medium" | "high" | "xhigh" | "max" | "auto" | "standard" | "hd";
export type ImageGenerationSize = "256x256" | "512x512" | "1024x1024" | "1536x1024" | "1024x1536" | "1792x1024" | "1024x1792" | "2048x2048" | "2048x1152" | "auto" | (string & {});
export type ImageOutputFormat = "png" | "jpeg" | "webp";

export interface ImageGenerationConfig {
    enabled: boolean;
    dailyLimit: number;
    provider: "gpt";
    model: string;
    quality: ImageGenerationQuality;
    size: ImageGenerationSize;
    outputFormat: ImageOutputFormat;
}

export interface ImageModelCapabilities {
    quality: readonly ImageGenerationQuality[];
    sizes: readonly ImageGenerationSize[];
    outputFormats: readonly ImageOutputFormat[];
    supportsAutoSize: boolean;
    supportsCustomSize: boolean;
    source: "upstream" | "openai-sdk-profile" | "conservative";
}
export type LogLevel = "all" | "debug" | "info" | "warn" | "error";

export interface PublicConfig {
    aiProvider: "gpt" | "deepseek";
    image: ImageGenerationConfig;
    memeSendMaxEdge: number | null;
    replyJudge: { model: string; timeoutMs: number; fallbackToMainOnInvalidOutput: boolean; turnWaitMs: number; provider?: string };
    gpt: { model: string; reasoningEffort: ReasoningEffort; verbosity: ModelVerbosity; configured: boolean };
    deepseek: { model: string; reasoningEffort: ReasoningEffort; configured: boolean };
    botLoopGuard: { maxCycles: number };
}

export type PublicConfigPatch =
    | { field: "aiProvider"; value: "gpt" | "deepseek" }
    | { field: "image"; value: ImageGenerationConfig }
    | { field: "memeSendMaxEdge"; value: number | null }
    | { field: "gpt.model"; value: string }
    | { field: "gpt.reasoningEffort"; value: ReasoningEffort }
    | { field: "gpt.verbosity"; value: ModelVerbosity }
    | { field: "deepseek.model"; value: string }
    | { field: "deepseek.reasoningEffort"; value: ReasoningEffort }
    | { field: "replyJudge.model"; value: string }
    | { field: "replyJudge.timeoutMs"; value: number }
    | { field: "replyJudge.fallbackToMainOnInvalidOutput"; value: boolean }
    | { field: "replyJudge.turnWaitMs"; value: number }
    | { field: "botLoopGuard.maxCycles"; value: number };

export type ConfigUpdateResult =
    | { ok: true; requiresRestart: boolean; changedFields: string[]; message: string }
    | { ok: false; requiresRestart: false; changedFields: string[]; message: string; details?: string };

export interface ConfigPatchResponse {
    result: Extract<ConfigUpdateResult, { ok: true }>;
    config: PublicConfig;
}

export interface GptModelsResponse {
    models: string[];
    entries: GptModelSummary[];
    imageCandidates: Array<{
        id: string;
        evidence: "upstream" | "name";
        capabilities: ImageModelCapabilities;
    }>;
    defaultImageCapabilities: ImageModelCapabilities;
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

export interface GroupSummary {
    groupOpenid: string;
    repliesEnabled: boolean;
    firstSeenAt: number;
    lastSeenAt: number;
    updatedAt: number;
    displayName?: string;
    memberCount: number;
}

export interface GroupMemberSummary {
    groupOpenid: string;
    memberOpenid: string;
    username: string;
    role?: string;
    firstSeenAt: number;
    lastSeenAt: number;
    updatedAt: number;
    platformBot: boolean;
    manualBot: boolean;
    autoBot: boolean;
    detectionMarks: number;
    lastDetectionAt: number | null;
    activeDetectionEvidence?: MemberBotDetectionEvidence[];
}

export interface MemberImageQuotaSnapshot {
    groupOpenid: string;
    memberOpenid: string;
    globalDailyLimit: number;
    dailyLimitOverride: number | null;
    effectiveDailyLimit: number;
    todayBaseUsed: number;
    todayBonusUsed: number;
    todayUsed: number;
    remainingBase: number;
    bonusCredits: number;
}

export interface ImageCreditGrantResponse {
    grant: { operationId: string; balanceAfter: number; duplicate: boolean };
    quota: MemberImageQuotaSnapshot;
}

export interface MemberBotDetectionEvidence {
    id: number;
    groupOpenid: string;
    memberOpenid: string;
    signalType: string;
    createdAt: number;
    expiresAt: number;
}

export interface MemberBotState {
    groupOpenid: string;
    memberOpenid: string;
    platformBot: boolean;
    manualBot: boolean;
    autoBot: boolean;
    detectionMarks: number;
    lastDetectionAt: number | null;
    createdAt: number;
    updatedAt: number;
}

export interface MemeLibraryResponse { files: string[] }
export interface MemeUploadResponse { filename: string }
export interface MemeDeleteResponse { deleted: true; filename: string }

export interface LogEntry {
    timestamp: string;
    level: LogLevel;
    text: string;
    rowId?: string;
    repeatCount?: number;
    firstTimestamp?: string;
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

export type EditorResourceId = "prompt:main" | "prompt:gpt" | "prompt:deepseek" | "prompt:reply-judge" | "meme:data";
export interface EditorResource {
    id: EditorResourceId;
    displayName: string;
    language: "markdown" | "json";
    content: string;
    version: string;
}
export interface ReloadResult { ok: boolean; message: string; revision?: number; count?: number; loadedAt?: string }
export interface EditorSaveResponse { ok: true; resource: EditorResource; reload: ReloadResult }
export type RuntimeEvent =
    | { type: "provider-error"; notice: ProviderErrorNotice }
    | { type: "members-updated" }
    | { type: "reload-failure"; target: "config" | "prompt" | "memes"; message: string; timestamp: string }
    | { type: "conversation-item"; conversationId: string; kind: ConversationSummary["kind"]; label: string; item: ConversationItem };
