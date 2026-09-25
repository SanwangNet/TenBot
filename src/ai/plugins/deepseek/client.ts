import { DEEPSEEK_SYSTEM_PROMPT } from "./prompt.js";
import { createResponsesModelPlugin } from "../shared/responses-client.js";

export const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export const DEFAULT_DEEPSEEK_MODEL = "deepseek-flash";

export interface DeepSeekPluginConfig {
    apiKey?: string;
    baseURL?: string;
    model?: string;
}

export function createDeepSeekPlugin(config: DeepSeekPluginConfig = {}) {
    return createResponsesModelPlugin({
        id: "deepseek",
        model: config.model ?? DEFAULT_DEEPSEEK_MODEL,
        apiKey: config.apiKey,
        baseURL: config.baseURL ?? DEFAULT_DEEPSEEK_BASE_URL,
        prompt: DEEPSEEK_SYSTEM_PROMPT,
        capabilities: { webSearch: false },
        reasoningEffort: "high",
        useBuiltInWebSearch: false,
    });
}
