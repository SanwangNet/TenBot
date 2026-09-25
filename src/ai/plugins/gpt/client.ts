import { createResponsesModelPlugin } from "../shared/responses-client.js";
import type { ModelVerbosity, ReasoningEffort } from "../../model-plugin.js";
import { DEFAULT_GPT_MODEL, DEFAULT_GPT_REASONING_EFFORT, DEFAULT_GPT_VERBOSITY } from "../../../config/config-validation.js";

export interface GptPluginConfig {
    apiKey?: string;
    baseURL?: string;
    model?: string;
    reasoningEffort?: ReasoningEffort;
    verbosity?: ModelVerbosity;
}

export function createGptPlugin(config: GptPluginConfig = {}) {
    return createResponsesModelPlugin({
        id: "gpt",
        model: config.model ?? DEFAULT_GPT_MODEL,
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        capabilities: { webSearch: true },
        reasoningEffort: config.reasoningEffort ?? DEFAULT_GPT_REASONING_EFFORT,
        verbosity: config.verbosity ?? DEFAULT_GPT_VERBOSITY,
        useBuiltInWebSearch: true,
    });
}
