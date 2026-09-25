import OpenAI from "openai";

import {
    collectMarkerSources,
    normalizeUrlCitation,
    renderCitations,
    type UrlCitation,
} from "../../citations.js";
import { normalizeTextReply } from "../../reply-result.js";
import { normalizeReplyMessages, parseQqReplyArguments } from "../../../skills/qq-reply/skill.js";
import { logger } from "../../../shared/logger.js";
import { AiResponseFailure } from "../../upstream-error.js";
import {
    ModelAbortedError,
    ModelProviderError,
    type ModelCapabilities,
    type ModelPlugin,
    type ModelToolExecution,
} from "../../model-plugin.js";

export interface ResponsesPluginConfig {
    id: string;
    model: string;
    apiKey?: string;
    baseURL?: string;
    prompt: string;
    capabilities: ModelCapabilities;
    reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh";
    verbosity?: "low" | "medium" | "high";
    useBuiltInWebSearch: boolean;
}

function providerError(provider: string, error: unknown, signal: AbortSignal): Error {
    if (signal.aborted) return new ModelAbortedError();
    if (error instanceof ModelAbortedError || error instanceof ModelProviderError || error instanceof AiResponseFailure) {
        return error;
    }
    return new ModelProviderError(provider, error);
}

/** Shared low-level adapter for built-in plugins backed by Responses-compatible APIs. */
export function createResponsesModelPlugin(config: ResponsesPluginConfig): ModelPlugin {
    let client: OpenAI | undefined;
    const getClient = (): OpenAI => {
        if (client) return client;
        if (!config.apiKey || !config.baseURL) {
            throw new ModelProviderError(config.id, new Error(
                config.id === "gpt" ? "缺少 CODEX_API_KEY 或 CODEX_BASE_URL" : "缺少 DEEPSEEK_API_KEY 或 DEEPSEEK_BASE_URL",
            ));
        }
        try {
            client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });
            return client;
        } catch (error) {
            throw new ModelProviderError(config.id, error);
        }
    };

    return {
        id: config.id,
        model: config.model,
        capabilities: config.capabilities,
        async generate(request, options) {
            if (options.signal.aborted) throw new ModelAbortedError();
            logger.debug("[AI input length]", request.input.length);
            if (request.imageUrls?.length) logger.debug("[AI image count]", request.imageUrls.length);

            const startedAt = Date.now();
            let requestInput: any = request.imageUrls?.length
                ? [{
                    role: "user",
                    content: [
                        { type: "input_text", text: request.input },
                        ...request.imageUrls.map((url) => ({ type: "input_image", image_url: url })),
                    ],
                }]
                : request.input;

            for (let turn = 0; turn < 3; turn++) {
                let stream: any;
                try {
                    const tools = [
                        ...(config.useBuiltInWebSearch ? [{ type: "web_search" as const }] : []),
                        ...request.tools,
                    ];
                    stream = await getClient().responses.create({
                        model: config.model,
                        instructions: config.prompt,
                        input: requestInput,
                        ...(config.reasoningEffort ? { reasoning: { effort: config.reasoningEffort } } : {}),
                        ...(config.verbosity ? { text: { verbosity: config.verbosity } } : {}),
                        tools: tools as any,
                        tool_choice: "auto",
                        store: false,
                        stream: true,
                    }, { signal: options.signal, maxRetries: 0 });
                } catch (error) {
                    throw providerError(config.id, error, options.signal);
                }

                await options.onEvent?.({ type: "streamStarted", elapsedMs: Date.now() - startedAt });
                type StreamTextPart = { outputIndex: number; contentIndex: number; text: string; citations: UrlCitation[] };
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
                let completedResponse: any;
                let searchNoticeSent = false;
                const abortStream = () => stream.controller?.abort();
                const handleAbort = () => abortStream();
                options.signal.addEventListener("abort", handleAbort, { once: true });
                if (options.signal.aborted) abortStream();
                try {
                    for await (const event of stream) {
                        if (options.signal.aborted) throw new ModelAbortedError();
                        logger.debug(`[AI:${config.id}] event`, event.type);

                        if (config.useBuiltInWebSearch && !searchNoticeSent &&
                            ["response.web_search_call.in_progress", "response.web_search_call.searching", "response.web_search_call.completed"].includes(event.type)) {
                            searchNoticeSent = true;
                            await options.onEvent?.({ type: "webSearchStarted" });
                        }
                        if (event.type === "response.output_text.delta") {
                            if (Number.isSafeInteger(event.output_index) && Number.isSafeInteger(event.content_index)) {
                                getTextPart(event.output_index, event.content_index).text += event.delta;
                            } else unindexedOutput += event.delta;
                        }
                        if (event.type === "response.output_text.done") {
                            if (Number.isSafeInteger(event.output_index) && Number.isSafeInteger(event.content_index)) {
                                getTextPart(event.output_index, event.content_index).text = event.text;
                            } else unindexedOutput = event.text;
                        }
                        if (event.type === "response.output_text.annotation.added") {
                            logger.debug(`[AI:${config.id}] citation annotation`, event.annotation?.type);
                            const citation = normalizeUrlCitation(event.annotation);
                            if (citation && Number.isSafeInteger(event.output_index) && Number.isSafeInteger(event.content_index)) {
                                getTextPart(event.output_index, event.content_index).citations.push(citation);
                            }
                        }
                        if (event.type === "response.completed") {
                            completedResponse = event.response;
                            for (const [outputIndex, item] of event.response.output.entries()) {
                                if (item.type !== "message") continue;
                                for (const [contentIndex, content] of item.content.entries()) {
                                    if (content.type !== "output_text") continue;
                                    const part = getTextPart(outputIndex, contentIndex);
                                    part.text = content.text;
                                    for (const annotation of content.annotations ?? []) {
                                        const citation = normalizeUrlCitation(annotation);
                                        if (citation) part.citations.push(citation);
                                    }
                                }
                            }
                            break;
                        }
                        if (event.type === "response.failed") throw new AiResponseFailure(event.response.error);
                        if (event.type === "response.incomplete") throw new Error("模型响应未完成");
                    }
                } catch (error) {
                    throw providerError(config.id, error, options.signal);
                } finally {
                    options.signal.removeEventListener("abort", handleAbort);
                    if (options.signal.aborted) abortStream();
                }

                if (options.signal.aborted) throw new ModelAbortedError();
                if (!completedResponse) throw new ModelProviderError(config.id, new Error("模型响应流意外结束"));

                const calls = (completedResponse.output ?? []).filter((item: any) => item.type === "function_call");
                const executions: ModelToolExecution[] = await Promise.all((calls as any[]).map((call) =>
                    request.executeTool({ name: String(call.name), arguments: String(call.arguments) })));
                const hasContinuation = executions.some((execution) => execution.kind === "continue");
                if (hasContinuation) {
                    if (turn === 2) throw new Error("meme_lookup 调用次数过多");
                    const originalInput = Array.isArray(requestInput)
                        ? requestInput
                        : [{ role: "user", content: request.input }];
                    requestInput = [
                        ...originalInput,
                        ...completedResponse.output,
                        ...calls.map((call: any, index: number) => {
                            const execution = executions[index];
                            return {
                                type: "function_call_output",
                                call_id: call.call_id,
                                output: execution.kind === "continue"
                                    ? execution.output
                                    : "请在查询完成后决定最终回复。",
                            };
                        }),
                    ];
                    continue;
                }

                if (unindexedOutput && ![...textParts.values()].some((part) => part.text)) {
                    getTextPart(0, 0).text = unindexedOutput;
                }
                const parts = [...textParts.values()].sort((a, b) =>
                    a.outputIndex - b.outputIndex || a.contentIndex - b.contentIndex);
                let unindexed = unindexedOutput;
                if (!parts.length && !unindexed) {
                    unindexed = (completedResponse.output ?? []).flatMap((item: any) => item.content ?? [])
                        .filter((part: any) => part.type === "output_text")
                        .map((part: any) => part.text).join("");
                }
                const markerSources = collectMarkerSources(parts);
                const renderedParts = parts.map((part) =>
                    renderCitations(part.text, part.citations, markerSources));
                const output = renderedParts.map((part) => part.content).join("") || unindexed;
                const elapsed = `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
                const reportCitations = (renderedCount: number, metadataUnavailable: boolean): void => {
                    if (renderedCount) logger.info("[AI] citations " + renderedCount);
                    if (metadataUnavailable) logger.debug("[AI] citation metadata unavailable");
                };

                if (output.trim() === "<NO_REPLY>") {
                    logger.info(`[AI] done provider=${config.id} ${elapsed}: <NO_REPLY>`);
                    return { kind: "no_reply" };
                }
                for (const execution of executions) {
                    if (execution.kind !== "result") continue;
                    if (execution.result.kind === "no_reply") {
                        logger.info(`[AI] done provider=${config.id} ${elapsed}: <NO_REPLY>`);
                        return execution.result;
                    }
                    const action = execution.result.action;
                    const rendered = action.messages.map((message) => {
                        const matchingPart = parts.find((part) => part.text === message.content);
                        return renderCitations(message.content, matchingPart?.citations ?? [], markerSources);
                    });
                    action.messages = normalizeReplyMessages(action.messages.map((message, messageIndex) =>
                        ({ ...message, content: rendered[messageIndex].content })));
                    if (!action.messages.length) continue;
                    reportCitations(
                        rendered.reduce((count, item) => count + item.renderedCount, 0),
                        rendered.some((item) => item.metadataUnavailable),
                    );
                    logger.info(`[AI] done provider=${config.id} ${elapsed}: messages=${action.messages.length}`);
                    return { kind: "reply", action };
                }
                if (!output.trim()) throw new Error("模型没有返回文本或有效 qq_reply");
                reportCitations(
                    renderedParts.reduce((count, part) => count + part.renderedCount, 0),
                    renderedParts.some((part) => part.metadataUnavailable),
                );
                logger.info(`[AI] done provider=${config.id} ${elapsed}: content length ${output.trim().length}`);
                const result = normalizeTextReply(output);
                if (!result) throw new Error("模型没有返回文本或有效 qq_reply");
                return result;
            }
            throw new Error("meme_lookup 调用次数过多");
        },
    };
}
