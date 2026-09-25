import "dotenv/config";

import { loadAppConfig } from "../config/config-validation.js";
import type { ModelPlugin } from "./model-plugin.js";
import { createDeepSeekPlugin } from "./plugins/deepseek/index.js";
import { createGptPlugin } from "./plugins/gpt/index.js";

export type { ModelProviderId } from "../config/config-types.js";

/** Pure selection entry point, also used by offline configuration tests. */
export function createModelPlugin(env: NodeJS.ProcessEnv = process.env): ModelPlugin {
    const config = loadAppConfig(env);
    if (config.ai.provider === "gpt") {
        return createGptPlugin({
            apiKey: config.ai.gpt.apiKey,
            baseURL: config.ai.gpt.baseURL,
            model: config.ai.gpt.model,
            reasoningEffort: config.ai.gpt.reasoningEffort,
            verbosity: config.ai.gpt.verbosity,
        });
    }
    return createDeepSeekPlugin({
        apiKey: config.ai.deepseek.apiKey,
        baseURL: config.ai.deepseek.baseURL,
        model: config.ai.deepseek.model,
        reasoningEffort: config.ai.deepseek.reasoningEffort,
    });
}

let activePlugin: ModelPlugin | undefined;

/** One provider is selected for the process lifetime; model failover is not implicit. */
export function getModelPlugin(): ModelPlugin {
    return activePlugin ??= createModelPlugin();
}
