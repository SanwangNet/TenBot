import type { AiResult } from "./reply-result.js";
import { getModelPlugin } from "./model-registry.js";
import type { ModelGenerateOptions, ModelPlugin, ModelRequest } from "./model-plugin.js";
import { lookupMeme, memeLookupTool } from "../skills/meme/skill.js";
import { normalizeReplyMessages, parseQqReplyArguments, qqReplyTool } from "../skills/qq-reply/skill.js";
import { logger } from "../shared/logger.js";
import type { MemeRuntimeSnapshot } from "../skills/meme/store.js";
import { isToolProtocolLeakError } from "./tool-protocol.js";
import type { AttemptPromptSnapshot } from "./attempt-snapshot.js";
import { captureAttemptRuntimeSnapshot } from "./attempt-snapshot.js";

export interface ChatOptions {
    signal: AbortSignal;
    onWebSearchStart?: () => void | Promise<void>;
    /** Images are sent only for the existing explicit vision path. */
    imageUrls?: string[];
    memeSnapshot?: MemeRuntimeSnapshot;
}

const tenBotTools = [qqReplyTool, memeLookupTool] as const;

function createRequest(plugin: ModelPlugin, input: string, options: ChatOptions, promptSnapshot: AttemptPromptSnapshot): ModelRequest {
    return {
        input,
        systemPrompt: promptSnapshot.content,
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
    promptSnapshot: AttemptPromptSnapshot,
): Promise<AiResult> {
    const request = createRequest(plugin, input, options, promptSnapshot);
    let currentRequest = request;
    const generateOptions: ModelGenerateOptions = {
        signal: options.signal,
        onEvent: async (event) => {
            if (event.type === "streamStarted") {
                logger.info(`[AI] stream provider=${plugin.id} ${(event.elapsedMs / 1000).toFixed(1)}s${event.elapsedMs > 10_000 ? " (slow)" : ""}`);
            } else if (event.type === "webSearchStarted") {
                logger.info(`[AI] web search provider=${plugin.id}`);
                await options.onWebSearchStart?.();
            }
        },
    };
    for (let recovery = 0; ; recovery++) {
        try {
            return await plugin.generate(currentRequest, generateOptions);
        } catch (error) {
            if (!isToolProtocolLeakError(error) || recovery >= 1 || options.signal.aborted) throw error;
            logger.info(`[AI] Tool Protocol Leakage recovery=1/1 provider=${plugin.id}`);
            currentRequest = {
                ...request,
                input: [request.input,
                    "最终输出协议校验未通过。请勿将内部 XML 或 JSON 协议作为普通文字输出。",
                    "需要回复时必须调用实际的 qq_reply 工具；静默规则仍按原回复策略执行。",
                ].join("\n"),
            };
        }
    }
}

export function chat(input: string, options: ChatOptions): Promise<AiResult> {
    const plugin = getModelPlugin();
    const snapshot = captureAttemptRuntimeSnapshot(plugin);
    return runModelPlugin(plugin, input, options, snapshot.prompt);
}
