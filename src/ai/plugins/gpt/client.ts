import { createResponsesModelPlugin } from "../shared/responses-client.js";

export interface GptPluginConfig {
    apiKey?: string;
    baseURL?: string;
    model?: string;
}

export function createGptPlugin(config: GptPluginConfig = {}) {
    return createResponsesModelPlugin({
        id: "gpt",
        model: config.model ?? "gpt-6-sol",
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        capabilities: { webSearch: true },
        reasoningEffort: "high",
        verbosity: "high",
        useBuiltInWebSearch: true,
    });
}
