import "dotenv/config";
import OpenAI from "openai";

import { SYSTEM_PROMPT } from "./prompt.js";
import { qqReplyTool, parseQqReplyArguments, type AiResult } from "./reply-result.js";
import { logger, truncateLogText } from "../shared/logger.js";

const apiKey = process.env.CODEX_API_KEY;
const baseURL = process.env.CODEX_BASE_URL;

if (!apiKey || !baseURL) {
    throw new Error("缺少 CODEX_API_KEY 或 CODEX_BASE_URL");
}

export const AI_MODEL = "gpt-6-sol";

const client = new OpenAI({ apiKey, baseURL });

interface ChatOptions {
    signal: AbortSignal;
    onWebSearchStart?: () => void | Promise<void>;
    /** Images are sent only for the existing explicit vision path. */
    imageUrls?: string[];
}

export async function chat(
    input: string,
    options: ChatOptions,
): Promise<AiResult> {
    logger.debug("[AI input]", input);
    if (options.imageUrls?.length) {
        logger.debug("[AI image URLs]", options.imageUrls);
    }

    const startedAt = Date.now();
    const requestInput: any =
        options.imageUrls && options.imageUrls.length > 0
            ? [{
                  role: "user",
                  content: [
                      { type: "input_text", text: input },
                      ...options.imageUrls.map((url) => ({
                          type: "input_image",
                          image_url: url,
                      })),
                  ],
              }]
            : input;

    const stream = await client.responses.create({
        model: AI_MODEL,
        instructions: SYSTEM_PROMPT,
        input: requestInput,
        reasoning: { effort: "medium" },
        text: { verbosity: "medium" },
        tools: [
            { type: "web_search" },
            qqReplyTool,
        ],
        tool_choice: "auto",
        store: false,
        stream: true,
    }, {
        signal: options.signal,
        maxRetries: 0,
    });

    const streamElapsed = Date.now() - startedAt;
    logger.info(
        `[AI] stream ${(streamElapsed / 1000).toFixed(1)}s${streamElapsed > 10_000 ? " (slow)" : ""}`,
    );

    let output = "";
    let searchNoticeSent = false;
    let completed = false;
    const functionNames = new Map<string, string>();
    const qqReplyCalls = new Map<number, string>();

    for await (const event of stream) {
        if (options.signal.aborted) {
            throw new Error("AI request aborted");
        }
        logger.debug("[AI stream event]", event.type);

        if (event.type === "response.web_search_call.searching" && !searchNoticeSent) {
            searchNoticeSent = true;
            logger.info("[AI] web search");
            await options.onWebSearchStart?.();
        }

        if (event.type === "response.output_text.delta") {
            output += event.delta;
        }

        if (event.type === "response.output_item.added" &&
            event.item.type === "function_call" && event.item.id) {
            functionNames.set(event.item.id, event.item.name);
        }

        if (event.type === "response.function_call_arguments.done" &&
            functionNames.get(event.item_id) === "qq_reply") {
            qqReplyCalls.set(event.output_index, event.arguments);
        }

        if (event.type === "response.output_item.done" &&
            event.item.type === "function_call" && event.item.name === "qq_reply") {
            qqReplyCalls.set(event.output_index, event.item.arguments);
        }

        if (event.type === "response.completed") {
            completed = true;
            const finalText: string[] = [];
            for (const [index, item] of event.response.output.entries()) {
                if (item.type === "function_call" && item.name === "qq_reply") {
                    qqReplyCalls.set(index, item.arguments);
                }
                if (item.type === "message") {
                    finalText.push(...item.content
                        .filter((part) => part.type === "output_text")
                        .map((part) => part.text));
                }
            }
            if (!output) {
                output = finalText.join("");
            }
            break;
        }

        if (event.type === "response.failed") {
            throw new Error(`模型请求失败：${JSON.stringify(event.response.error)}`);
        }
        if (event.type === "response.incomplete") {
            throw new Error("模型响应未完成");
        }
    }

    if (options.signal.aborted) {
        throw new Error("AI request aborted");
    }
    if (!completed) {
        throw new Error("模型响应流意外结束");
    }

    const elapsed = `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
    if (output.trim() === "<NO_REPLY>") {
        logger.info(`[AI] done ${elapsed}: <NO_REPLY>`);
        return { kind: "no_reply" };
    }

    for (const [, argumentsJson] of [...qqReplyCalls.entries()].sort(([a], [b]) => a - b)) {
        const action = parseQqReplyArguments(argumentsJson);
        if (!action) {
            logger.debug("[AI] invalid qq_reply arguments discarded");
            continue;
        }
        if (action.content.trim() === "<NO_REPLY>") {
            logger.info(`[AI] done ${elapsed}: <NO_REPLY>`);
            return { kind: "no_reply" };
        }
        logger.info(`[AI] done ${elapsed}: ${truncateLogText(action.content)}`);
        return { kind: "reply", source: "qq_reply", action };
    }

    if (!output.trim()) {
        throw new Error("模型没有返回文本或有效 qq_reply");
    }

    logger.info(`[AI] done ${elapsed}: ${truncateLogText(output)}`);
    return {
        kind: "reply",
        source: "text",
        action: { content: output.trim(), mentions: [], quote: "auto" },
    };
}
