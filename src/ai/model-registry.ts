import "dotenv/config";

import type { ModelPlugin } from "./model-plugin.js";
import { createDeepSeekPlugin, DEFAULT_DEEPSEEK_BASE_URL, DEFAULT_DEEPSEEK_MODEL } from "./plugins/deepseek/index.js";
import { createGptPlugin } from "./plugins/gpt/index.js";

export type ModelProviderId = "gpt" | "deepseek";

/** Pure selection entry point, also used by offline configuration tests. */
export function createModelPlugin(env: NodeJS.ProcessEnv = process.env): ModelPlugin {
    const provider = (env.AI_PROVIDER ?? "gpt").trim().toLowerCase() || "gpt";
    if (provider === "gpt") {
        return createGptPlugin({
            apiKey: env.CODEX_API_KEY,
            baseURL: env.CODEX_BASE_URL,
            model: env.CODEX_MODEL ?? "gpt-6-sol",
        });
    }
    if (provider === "deepseek") {
        return createDeepSeekPlugin({
            apiKey: env.DEEPSEEK_API_KEY,
            baseURL: env.DEEPSEEK_BASE_URL ?? DEFAULT_DEEPSEEK_BASE_URL,
            model: env.DEEPSEEK_MODEL ?? DEFAULT_DEEPSEEK_MODEL,
        });
    }
    throw new Error(`不支持的 AI_PROVIDER: ${provider}`);
}

let activePlugin: ModelPlugin | undefined;

/** One provider is selected for the process lifetime; model failover is not implicit. */
export function getModelPlugin(): ModelPlugin {
    return activePlugin ??= createModelPlugin();
}
