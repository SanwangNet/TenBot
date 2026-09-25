import type { ReasoningEffort, ModelVerbosity } from "../ai/model-plugin.js";
import type { PromptProvider } from "../ai/prompt-store.js";

export type QqConnectionState = "connecting" | "connected" | "disconnected" | "error";

export interface RuntimeStatus {
    qq: QqConnectionState;
    provider: {
        id: PromptProvider;
        model: string;
        webSearch: boolean;
        configured: boolean;
        reasoningEffort?: ReasoningEffort;
        verbosity?: ModelVerbosity;
    };
    activeCycles: number;
    contextConversations: number;
    memes: {
        count: number;
        revision: number;
        loadedAt: string;
        path?: string;
        sampleNames?: string[];
    };
    prompt: {
        provider: PromptProvider;
        revision: number;
        loadedAt: string;
        path?: string;
        characters?: number;
        lines?: number;
    };
    shuttingDown: boolean;
}
