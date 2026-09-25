import "dotenv/config";

import { loadAppConfig } from "../config/config-validation.js";
import type { AppConfig } from "../config/config-types.js";
import type { ModelPlugin } from "./model-plugin.js";
import { createDeepSeekPlugin } from "./plugins/deepseek/index.js";
import { createGptPlugin } from "./plugins/gpt/index.js";

export type { ModelProviderId } from "../config/config-types.js";
import type { ModelProviderId } from "../config/config-types.js";

export const MODEL_PROVIDERS: readonly { id: ModelProviderId; label: string }[] = Object.freeze([
    { id: "gpt", label: "GPT" },
    { id: "deepseek", label: "DeepSeek" },
]);

export function cycleModelProvider(current: ModelProviderId, delta: number): ModelProviderId {
    const index = MODEL_PROVIDERS.findIndex((provider) => provider.id === current);
    const next = (Math.max(0, index) + delta % MODEL_PROVIDERS.length + MODEL_PROVIDERS.length) % MODEL_PROVIDERS.length;
    return MODEL_PROVIDERS[next]?.id ?? current;
}

/** Pure selection entry point, also used by offline configuration tests. */
export function createModelPlugin(env: NodeJS.ProcessEnv = process.env): ModelPlugin {
    return createModelPluginFromConfig(loadAppConfig(env));
}

/** Build a fresh immutable provider instance before the Runtime swaps its active pointer. */
export function createModelPluginFromConfig(config: AppConfig): ModelPlugin {
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

export function replaceModelPlugin(plugin: ModelPlugin): void {
    activePlugin = plugin;
}
