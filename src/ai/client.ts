import type { AiResult } from "./reply-result.js";
import { getModelPlugin } from "./model-registry.js";
import type { ModelPlugin } from "./model-plugin.js";
import type { ModelRequest } from "./model-plugin.js";
import { lookupMeme, memeLookupTool } from "../skills/meme/skill.js";
import { normalizeReplyMessages, parseQqReplyArguments, qqReplyTool } from "../skills/qq-reply/skill.js";
import { logger } from "../shared/logger.js";
import { getPromptStore } from "./prompt-store.js";
import type { MemeRuntimeSnapshot } from "../skills/meme/store.js";

export interface ChatOptions {
    signal: AbortSignal;
    onWebSearchStart?: () => void | Promise<void>;
    /** Images are sent only for the existing explicit vision path. */
    imageUrls?: string[];
    memeSnapshot?: MemeRuntimeSnapshot;
}

const tenBotTools = [qqReplyTool, memeLookupTool] as const;

function createRequest(plugin: ModelPlugin, input: string, options: ChatOptions, promptSnapshot?: string): ModelRequest {
    return {
        input,
        systemPrompt: promptSnapshot ?? getPromptStore().getForModel(plugin.id)?.content ?? "",
        imageUrls: options.imageUrls,
        tools: tenBotTools,
        async executeTool(call) {
            if (call.name === "meme_lookup") {
                return { kind: "continue", output: lookupMeme(call.arguments, options.memeSnapshot) };
            }
            if (call.name === "qq_reply") {
                const action = parseQqReplyArguments(call.arguments);
                if (!action) return { kind: "ignore" };
                if (action.messages.length === 1 && action.messages[0].content === "<NO_REPLY>") {
                    return { kind: "result", result: { kind: "no_reply" } };
                }
                action.messages = normalizeReplyMessages(action.messages);
                return { kind: "result", result: { kind: "reply", action } };
            }
            return { kind: "ignore" };
        },
    };
}

export async function runModelPlugin(
    plugin: ModelPlugin,
    input: string,
    options: ChatOptions,
    promptSnapshot?: string,
): Promise<AiResult> {
    return plugin.generate(createRequest(plugin, input, options, promptSnapshot), {
        signal: options.signal,
        onEvent: async (event) => {
            if (event.type === "streamStarted") {
                logger.info(`[AI] stream provider=${plugin.id} ${(event.elapsedMs / 1000).toFixed(1)}s${event.elapsedMs > 10_000 ? " (slow)" : ""}`);
            } else if (event.type === "webSearchStarted") {
                logger.info(`[AI] web search provider=${plugin.id}`);
                await options.onWebSearchStart?.();
            }
        },
    });
}

export function chat(input: string, options: ChatOptions): Promise<AiResult> {
    return runModelPlugin(getModelPlugin(), input, options);
}
