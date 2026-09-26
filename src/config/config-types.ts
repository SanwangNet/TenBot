import type { ModelVerbosity, ReasoningEffort } from "../ai/model-plugin.js";
import type { LogLevel } from "../shared/logger.js";
import type { FrontMode } from "../front/wake-level.js";

export type ModelProviderId = "gpt" | "deepseek";

export interface AppConfig {
    frontMode: FrontMode;
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
    replyJudge: {
        provider?: "openai-compatible";
        model?: string;
        baseURL?: string;
        apiKey?: string;
        timeoutMs: number;
    };
    logging: {
        level: LogLevel;
    };
    web: {
        host: string;
        port: number;
    };
    botLoopGuard: {
        maxCycles: number;
        automatedPeerIds: readonly string[];
    };
}

export interface PublicConfig {
    aiProvider: ModelProviderId;
    replyJudge: {
        model: string;
        timeoutMs: number;
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
    logLevel: LogLevel;
    botLoopGuard: {
        maxCycles: number;
        automatedPeerCount: number;
    };
}

export type PublicConfigPatch =
    | { field: "aiProvider"; value: ModelProviderId }
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

export type AutomatedPeerConfigResult =
    | { ok: true; changed: boolean; peerIds: string[]; message: string }
    | { ok: false; changed: false; peerIds: string[]; message: string; details?: string };

export interface ConfigStore {
    /** Internal Runtime input; never exposed through TenBotControl. */
    getAppConfig(): AppConfig;
    getEnvPath(): string;
    getPublicConfig(): PublicConfig;
    updatePublicConfig(patch: PublicConfigPatch): Promise<ConfigUpdateResult>;
    getAutomatedPeerIds(): string[];
    addAutomatedPeer(id: string): Promise<AutomatedPeerConfigResult>;
    removeAutomatedPeer(id: string): Promise<AutomatedPeerConfigResult>;
}
