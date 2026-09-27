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
import { TenBotError } from "../../../errors/tenbot-error.js";
import { isToolProtocolLeak, ToolProtocolLeakError } from "../../tool-protocol.js";
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
    capabilities: ModelCapabilities;
    reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh";
    verbosity?: "low" | "medium" | "high";
    useBuiltInWebSearch: boolean;
}

function providerError(provider: string, error: unknown, signal: AbortSignal): Error {
    if (signal.aborted) return new ModelAbortedError();
    if (error instanceof ModelAbortedError || error instanceof ModelProviderError || error instanceof AiResponseFailure || error instanceof TenBotError) {
        return error;
    }
    return new ModelProviderError(provider, error);
}

function summarizeCompletedResponse(response: any): Record<string, unknown> {
    const output = Array.isArray(response?.output) ? response.output : [];
    const usage = response?.usage ?? {};
    return {
        id: response?.id,
        status: response?.status,
        model: response?.model,
        outputTypes: output.map((item: any) => item?.type ?? "unknown"),
        functionCalls: output.filter((item: any) => item?.type === "function_call").length,
        messages: output.filter((item: any) => item?.type === "message").length,
        usage: {
            inputTokens: usage.input_tokens,
            cachedTokens: usage.input_tokens_details?.cached_tokens,
            outputTokens: usage.output_tokens,
            reasoningTokens: usage.output_tokens_details?.reasoning_tokens,
            totalTokens: usage.total_tokens,
        },
        createdAt: response?.created_at,
        completedAt: response?.completed_at,
    };
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
        reasoningEffort: config.reasoningEffort,
        verbosity: config.verbosity,
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
                    const responseRequest = {
                        model: config.model,
                        instructions: request.systemPrompt,
                        input: requestInput,
                        ...(config.reasoningEffort ? { reasoning: { effort: config.reasoningEffort } } : {}),
                        ...(config.verbosity ? { text: { verbosity: config.verbosity } } : {}),
                        tools: tools as any,
                        tool_choice: "auto" as const,
                        store: false as const,
                        stream: true as const,
                    };
                    logger.all(`[AI:${config.id}] request`, {
                        provider: config.id,
                        model: responseRequest.model,
                        instructions: responseRequest.instructions,
                        input: responseRequest.input,
                        reasoning: responseRequest.reasoning,
                        text: responseRequest.text,
                        tools: responseRequest.tools,
                        tool_choice: responseRequest.tool_choice,
                        stream: responseRequest.stream,
                        store: responseRequest.store,
                    });
                    stream = await getClient().responses.create(responseRequest, { signal: options.signal, maxRetries: 0 });
                } catch (error) {
                    throw providerError(config.id, error, options.signal);
                }

                await options.onEvent?.({ type: "streamStarted", elapsedMs: Date.now() - startedAt });
                const streamStartedAt = Date.now();
                const streamStats = {
                    events: 0,
                    reasoningDeltas: 0,
                    reasoningChars: 0,
                    outputTextDeltas: 0,
                    outputTextChars: 0,
                    toolArgumentDeltas: 0,
                    toolArgumentChars: 0,
                    webSearchEvents: 0,
                    outputItemEvents: 0,
                };
                let terminalEvent = "ended";
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
                        streamStats.events++;
                        if (event.type === "response.reasoning_text.delta") {
                            streamStats.reasoningDeltas++;
                            if (typeof event.delta === "string") streamStats.reasoningChars += event.delta.length;
                        }
                        if (event.type === "response.output_text.delta") {
                            streamStats.outputTextDeltas++;
                            if (typeof event.delta === "string") streamStats.outputTextChars += event.delta.length;
                        }
                        if (event.type === "response.function_call_arguments.delta") {
                            streamStats.toolArgumentDeltas++;
                            if (typeof event.delta === "string") streamStats.toolArgumentChars += event.delta.length;
                        }
                        if (event.type.startsWith("response.web_search_call.")) streamStats.webSearchEvents++;
                        if (event.type.startsWith("response.output_item.")) streamStats.outputItemEvents++;

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
                            terminalEvent = "completed";
                            completedResponse = event.response;
                            logger.all(`[AI:${config.id}] completed`, summarizeCompletedResponse(event.response));
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
                        if (event.type === "response.failed") {
                            terminalEvent = "failed";
                            logger.all(`[AI:${config.id}] response failed`, event.response?.error);
                            throw new AiResponseFailure(event.response.error);
                        }
                        if (event.type === "response.incomplete") {
                            terminalEvent = "incomplete";
                            logger.all(`[AI:${config.id}] response incomplete`, {
                                id: event.response?.id,
                                status: event.response?.status,
                                incompleteDetails: event.response?.incomplete_details,
                            });
                            throw new TenBotError("M:A_MG_IRS", { safeDetails: { provider: config.id } });
                        }
                    }
                } catch (error) {
                    throw providerError(config.id, error, options.signal);
                } finally {
                    options.signal.removeEventListener("abort", handleAbort);
                    if (options.signal.aborted) abortStream();
                    if (options.signal.aborted) terminalEvent = "aborted";
                    logger.all(`[AI:${config.id}] stream summary`, {
                        ...streamStats,
                        terminal: terminalEvent,
                        elapsedMs: Date.now() - streamStartedAt,
                    });
                }

                if (options.signal.aborted) throw new ModelAbortedError();
                if (!completedResponse) {
                    throw new TenBotError("M:A_MG_IRS", { safeDetails: { provider: config.id } });
                }

                const calls = (completedResponse.output ?? []).filter((item: any) => item.type === "function_call");
                const executions: ModelToolExecution[] = await Promise.all((calls as any[]).map(async (call) => {
                    logger.all(`[AI:${config.id}] tool call`, { name: String(call.name), arguments: call.arguments });
                    try {
                        const execution = await request.executeTool({ name: String(call.name), arguments: String(call.arguments) });
                        logger.all(`[AI:${config.id}] tool result`, { name: String(call.name), execution });
                        return execution;
                    } catch (error) {
                        logger.all(`[AI:${config.id}] tool exception`, { name: String(call.name), error });
                        if (options.signal.aborted || error instanceof ModelAbortedError) throw error;
                        throw new TenBotError("M:B_TL_TEF", { cause: error, safeDetails: { provider: config.id } });
                    }
                }));
                const hasContinuation = executions.some((execution) => execution.kind === "continue");
                if (hasContinuation) {
                    if (turn === 2) throw new TenBotError("M:C_TL_TCL", { safeDetails: { provider: config.id } });
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
                logger.all(`[AI:${config.id}] final collected text`, output);
                const protocolLeak = isToolProtocolLeak(output);
                logger.all(`[AI:${config.id}] protocol leak classification`, { detected: protocolLeak, outputLength: output.length });
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
                    if (!action.messages.length && !action.meme) continue;
                    reportCitations(
                        rendered.reduce((count, item) => count + item.renderedCount, 0),
                        rendered.some((item) => item.metadataUnavailable),
                    );
                    logger.info(`[AI] done provider=${config.id} ${elapsed}: messages=${action.messages.length}`);
                    return { kind: "reply", action };
                }
                if (protocolLeak) throw new ToolProtocolLeakError();
                const normalizedTextReply = normalizeTextReply(output);
                const diagnosticOutput = completedResponse.output ?? [];
                const diagnosticMessages = diagnosticOutput.filter((item: any) => item.type === "message");
                const nvoDiagnostics = {
                    provider: config.id,
                    outputItemCount: diagnosticOutput.length,
                    outputItemTypes: diagnosticOutput.map((item: any) => item?.type ?? "unknown"),
                    messageCount: diagnosticMessages.length,
                    messageContentTypes: diagnosticMessages.flatMap((item: any) => (item.content ?? []).map((content: any) => content?.type ?? "unknown")),
                    functionCallCount: calls.length,
                    toolExecutionCount: executions.length,
                    textPartsCount: textParts.size,
                    unindexedOutputLength: unindexedOutput.length,
                    finalOutputLength: output.length,
                    normalizeTextReplyIsNull: normalizedTextReply === null,
                };
                if (!output.trim()) {
                    logger.all("[AI] NVO diagnostics", nvoDiagnostics);
                    throw new TenBotError("M:A_MG_NVO", { safeDetails: { provider: config.id } });
                }
                reportCitations(
                    renderedParts.reduce((count, part) => count + part.renderedCount, 0),
                    renderedParts.some((part) => part.metadataUnavailable),
                );
                logger.info(`[AI] done provider=${config.id} ${elapsed}: content length ${output.trim().length}`);
                if (!normalizedTextReply) {
                    logger.all("[AI] NVO diagnostics", nvoDiagnostics);
                    throw new TenBotError("M:A_MG_NVO", { safeDetails: { provider: config.id } });
                }
                return normalizedTextReply;
            }
            throw new TenBotError("M:C_TL_TCL", { safeDetails: { provider: config.id } });
        },
    };
}
