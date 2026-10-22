import type { ModelVerbosity, ReasoningEffort } from "../ai/model-plugin.js";
import type { FrontMode } from "../front/wake-level.js";

export type ModelProviderId = "gpt" | "deepseek";
export type ImageGenerationProvider = "gpt";
export type ImageGenerationQuality = "low" | "medium" | "high" | "xhigh" | "max" | "auto" | "standard" | "hd";
export type ImageGenerationSize = "256x256" | "512x512" | "1024x1024" | "1536x1024" | "1024x1536" | "1792x1024" | "1024x1792" | "2048x2048" | "2048x1152" | "auto" | (string & {});
export type ImageOutputFormat = "png" | "jpeg" | "webp";

/** Public, independently configurable image generation settings; credentials reuse ai.gpt. */
export interface ImageGenerationConfig {
    enabled: boolean;
    dailyLimit: number;
    provider: ImageGenerationProvider;
    model: string;
    quality: ImageGenerationQuality;
    size: ImageGenerationSize;
    outputFormat: ImageOutputFormat;
}

export interface AppConfig {
    frontMode: FrontMode;
    botTimeZone: string;
    botAdminIds: readonly string[];
    memeSendMaxEdge: number | null;
    qq: {
        appId?: string;
        appSecret?: string;
    };
    ai: {
        provider: ModelProviderId;
        gpt: {
            apiKey?: string;
            baseURL?: string;
            model: string;
            reasoningEffort: ReasoningEffort;
            verbosity: ModelVerbosity;
        };
        deepseek: {
            apiKey?: string;
            baseURL: string;
            model: string;
            reasoningEffort: ReasoningEffort;
        };
    };
    image: ImageGenerationConfig;
    replyJudge: {
        provider?: "openai-compatible";
        model?: string;
        baseURL?: string;
        apiKey?: string;
        timeoutMs: number;
        fallbackToMainOnInvalidOutput: boolean;
        turnWaitMs: number;
    };
    web: {
        host: string;
        port: number;
    };
    botLoopGuard: {
        maxCycles: number;
    };
}

export interface PublicConfig {
    aiProvider: ModelProviderId;
    image: ImageGenerationConfig;
    memeSendMaxEdge: number | null;
    replyJudge: {
        model: string;
        timeoutMs: number;
        fallbackToMainOnInvalidOutput: boolean;
        turnWaitMs: number;
        provider?: "openai-compatible";
    };
    gpt: {
        model: string;
        reasoningEffort: ReasoningEffort;
        verbosity: ModelVerbosity;
        configured: boolean;
    };
    deepseek: {
        model: string;
        reasoningEffort: ReasoningEffort;
        configured: boolean;
    };
    botLoopGuard: {
        maxCycles: number;
    };
}

export type PublicConfigPatch =
    | { field: "aiProvider"; value: ModelProviderId }
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
    | {
        ok: true;
        requiresRestart: boolean;
        changedFields: string[];
        message: string;
    }
    | {
        ok: false;
        requiresRestart: false;
        changedFields: string[];
        message: string;
        details?: string;
    };

export interface ConfigStore {
    /** Internal Runtime input; never exposed through TenBotControl. */
    getAppConfig(): AppConfig;
    getEnvPath(): string;
    getPublicConfig(): PublicConfig;
    updatePublicConfig(patch: PublicConfigPatch): Promise<ConfigUpdateResult>;
}
