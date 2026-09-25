import { createResponsesModelPlugin } from "../shared/responses-client.js";
import type { ReasoningEffort } from "../../model-plugin.js";
import { DEFAULT_DEEPSEEK_BASE_URL, DEFAULT_DEEPSEEK_MODEL, DEFAULT_DEEPSEEK_REASONING_EFFORT } from "../../../config/config-validation.js";

export { DEFAULT_DEEPSEEK_BASE_URL, DEFAULT_DEEPSEEK_MODEL } from "../../../config/config-validation.js";

export interface DeepSeekPluginConfig {
    apiKey?: string;
    baseURL?: string;
    model?: string;
    reasoningEffort?: ReasoningEffort;
}

export function createDeepSeekPlugin(config: DeepSeekPluginConfig = {}) {
    return createResponsesModelPlugin({
        id: "deepseek",
        model: config.model ?? DEFAULT_DEEPSEEK_MODEL,
        apiKey: config.apiKey,
        baseURL: config.baseURL ?? DEFAULT_DEEPSEEK_BASE_URL,
        capabilities: { webSearch: false },
        reasoningEffort: config.reasoningEffort ?? DEFAULT_DEEPSEEK_REASONING_EFFORT,
        useBuiltInWebSearch: false,
    });
}
