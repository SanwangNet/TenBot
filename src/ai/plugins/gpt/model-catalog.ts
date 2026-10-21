import OpenAI from "openai";

export interface GptModelCatalogConfig {
    apiKey?: string;
    baseURL?: string;
}

/** Reads only model IDs from the configured Responses-compatible upstream. */
export async function listGptModelIds(config: GptModelCatalogConfig): Promise<string[]> {
    const apiKey = config.apiKey?.trim();
    const baseURL = config.baseURL?.trim();
    if (!apiKey || !baseURL) throw new Error("GPT credentials are not configured");

    const client = new OpenAI({ apiKey, baseURL, timeout: 15_000, maxRetries: 0 });
    const ids = new Set<string>();
    for await (const model of client.models.list()) {
        if (typeof model.id === "string" && model.id.trim() && model.id.length <= 128 && !/[\r\n]/.test(model.id)) {
            ids.add(model.id);
        }
    }
    return [...ids].sort((left, right) => left.localeCompare(right));
}
