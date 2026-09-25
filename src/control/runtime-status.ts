import type { PromptProvider } from "../ai/prompt-store.js";

export type QqConnectionState = "connecting" | "connected" | "disconnected" | "error";

export interface RuntimeStatus {
    qq: QqConnectionState;
    provider: {
        id: PromptProvider;
        model: string;
        webSearch: boolean;
        configured: boolean;
    };
    activeCycles: number;
    contextConversations: number;
    memes: {
        count: number;
        revision: number;
        loadedAt: string;
    };
    prompt: {
        provider: PromptProvider;
        revision: number;
        loadedAt: string;
    };
    shuttingDown: boolean;
}
