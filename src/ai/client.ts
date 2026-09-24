import "dotenv/config";
import OpenAI from "openai";

import {
    collectMarkerSources,
    normalizeUrlCitation,
    renderCitations,
    type CitedText,
} from "./citations.js";
import { SYSTEM_PROMPT } from "./prompt.js";
import { normalizeTextReply, type AiResult } from "./reply-result.js";
import { normalizeReplyMessages, qqReplyTool, parseQqReplyArguments } from "../skills/qq-reply/skill.js";
import { logger } from "../shared/logger.js";
import { AiResponseFailure } from "./upstream-error.js";
import { lookupMeme, memeLookupTool } from "../skills/meme/skill.js";

export const AI_MODEL = "gpt-6-sol";

let client: OpenAI | undefined;

function getClient(): OpenAI {
    if (client) return client;
    const apiKey = process.env.CODEX_API_KEY;
    const baseURL = process.env.CODEX_BASE_URL;
    if (!apiKey || !baseURL) {
        throw new Error("缺少 CODEX_API_KEY 或 CODEX_BASE_URL");
    }
    client = new OpenAI({ apiKey, baseURL });
    return client;
}

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
    logger.debug("[AI input length]", input.length);
    if (options.imageUrls?.length) {
        logger.debug("[AI image count]", options.imageUrls.length);
    }

    const startedAt = Date.now();
    let requestInput: any =
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

    let searchNoticeSent = false;
    for (let turn = 0; turn < 3; turn++) {
    const stream = await getClient().responses.create({
        model: AI_MODEL,
        instructions: SYSTEM_PROMPT,
        input: requestInput,
        reasoning: { effort: "low" },
        text: { verbosity: "low" },
        tools: [
            { type: "web_search" },
            qqReplyTool,
            memeLookupTool,
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

    type StreamTextPart = CitedText & { outputIndex: number; contentIndex: number };
    const textParts = new Map<string, StreamTextPart>();
    let unindexedOutput = "";
    const getTextPart = (outputIndex: number, contentIndex: number): StreamTextPart => {
        const key = `${outputIndex}:${contentIndex}`;
        let part = textParts.get(key);
        if (!part) {
            part = { outputIndex, contentIndex, text: "", citations: [] };
            textParts.set(key, part);
        }
        return part;
    };
    let completed = false;
    let completedResponse: any;
    const functionNames = new Map<string, string>();
    const qqReplyCalls = new Map<number, string>();

    const abortStream = () => stream.controller.abort();
    options.signal.addEventListener("abort", abortStream, { once: true });
    if (options.signal.aborted) abortStream();
    try {
        for await (const event of stream) {
            if (options.signal.aborted) {
                throw new Error("AI request aborted");
            }
            logger.debug("[AI stream event]", event.type);

            if (["response.web_search_call.in_progress", "response.web_search_call.searching", "response.web_search_call.completed"].includes(event.type) && !searchNoticeSent) {
                searchNoticeSent = true;
                logger.info("[AI] web search");
                await options.onWebSearchStart?.();
            }

            if (event.type === "response.output_text.delta") {
                if (Number.isSafeInteger(event.output_index) && Number.isSafeInteger(event.content_index)) {
                    getTextPart(event.output_index, event.content_index).text += event.delta;
                } else {
                    unindexedOutput += event.delta;
                }
            }

            if (event.type === "response.output_text.done") {
                if (Number.isSafeInteger(event.output_index) && Number.isSafeInteger(event.content_index)) {
                    getTextPart(event.output_index, event.content_index).text = event.text;
                } else {
                    unindexedOutput = event.text;
                }
            }

            if (event.type === "response.output_text.annotation.added") {
                logger.debug("[AI citation annotation]", event.annotation?.type);
                const citation = normalizeUrlCitation(event.annotation);
                if (citation && Number.isSafeInteger(event.output_index) &&
                    Number.isSafeInteger(event.content_index)) {
                    const part = getTextPart(event.output_index, event.content_index);
                    part.citations = [...part.citations, citation];
                }
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
                completedResponse = event.response;
                for (const [index, item] of event.response.output.entries()) {
                    if (item.type === "function_call" && item.name === "qq_reply") {
                        qqReplyCalls.set(index, item.arguments);
                    }
                    if (item.type === "message") {
                        for (const [contentIndex, content] of item.content.entries()) {
                            if (content.type !== "output_text") continue;
                            const part = getTextPart(index, contentIndex);
                            part.text = content.text;
                            for (const annotation of content.annotations ?? []) {
                                const citation = normalizeUrlCitation(annotation);
                                if (citation) part.citations = [...part.citations, citation];
                            }
                        }
                    }
                }
                break;
            }

            if (event.type === "response.failed") {
                throw new AiResponseFailure(event.response.error);
            }
            if (event.type === "response.incomplete") {
                throw new Error("模型响应未完成");
            }
        }
    } finally {
        options.signal.removeEventListener("abort", abortStream);
        if (options.signal.aborted) abortStream();
    }

    if (options.signal.aborted) {
        throw new Error("AI request aborted");
    }
    if (!completed) {
        throw new Error("模型响应流意外结束");
    }

    const memeCalls = completedResponse.output.filter((item: any) =>
        item.type === "function_call" && item.name === "meme_lookup");
    if (memeCalls.length) {
        if (turn === 2) throw new Error("meme_lookup 调用次数过多");
        requestInput = [
            ...(Array.isArray(requestInput) ? requestInput : [{ role: "user", content: input }]),
            ...completedResponse.output,
            ...completedResponse.output.filter((item: any) => item.type === "function_call").map((call: any) => ({
                type: "function_call_output", call_id: call.call_id,
                output: call.name === "meme_lookup" ? lookupMeme(call.arguments) : "请在查询完成后决定最终回复。",
            })),
        ];
        continue;
    }

    if (unindexedOutput && ![...textParts.values()].some((part) => part.text)) {
        getTextPart(0, 0).text = unindexedOutput;
    }
    const parts = [...textParts.values()]
        .sort((a, b) => a.outputIndex - b.outputIndex || a.contentIndex - b.contentIndex);
    const markerSources = collectMarkerSources(parts);
    const renderedParts = parts.map((part) =>
        renderCitations(part.text, part.citations, markerSources));
    const output = renderedParts.map((part) => part.content).join("");
    const reportCitations = (renderedCount: number, metadataUnavailable: boolean): void => {
        if (renderedCount) logger.info("[AI] citations " + renderedCount);
        if (metadataUnavailable) logger.debug("[AI] citation metadata unavailable");
    };

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
        if (action.messages.length === 1 && action.messages[0].content === "<NO_REPLY>") {
            logger.info(`[AI] done ${elapsed}: <NO_REPLY>`);
            return { kind: "no_reply" };
        }
        const rendered = action.messages.map((message) => {
            const matchingPart = parts.find((part) => part.text === message.content);
            return renderCitations(message.content, matchingPart?.citations ?? [], markerSources);
        });
        action.messages = normalizeReplyMessages(action.messages.map((message, index) =>
            ({ ...message, content: rendered[index].content })));
        if (!action.messages.length) continue;
        reportCitations(
            rendered.reduce((count, item) => count + item.renderedCount, 0),
            rendered.some((item) => item.metadataUnavailable),
        );
        logger.info(`[AI] done ${elapsed}: messages=${action.messages.length}`);
        return { kind: "reply", action };
    }

    if (!output.trim()) {
        throw new Error("模型没有返回文本或有效 qq_reply");
    }

    reportCitations(
        renderedParts.reduce((count, part) => count + part.renderedCount, 0),
        renderedParts.some((part) => part.metadataUnavailable),
    );
    logger.info(`[AI] done ${elapsed}: content length ${output.trim().length}`);
    return normalizeTextReply(output)!;
    }
    throw new Error("meme_lookup 调用次数过多");
}
