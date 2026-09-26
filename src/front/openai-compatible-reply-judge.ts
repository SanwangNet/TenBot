import OpenAI from "openai";
import { TenBotError } from "../errors/tenbot-error.js";
import { logger } from "../shared/logger.js";
import { parseReplyJudgeOutput, type ReplyJudge, type ReplyJudgeRequest } from "./reply-judge.js";
import type { ReplyJudgePromptSnapshot } from "./reply-judge-prompt-store.js";

export interface ReplyJudgeProviderSnapshot {
    readonly provider?: string;
    readonly model?: string;
    readonly baseURL?: string;
    readonly apiKey?: string;
    readonly timeoutMs: number;
    readonly prompt: ReplyJudgePromptSnapshot;
}

export type CaptureReplyJudgeSnapshot = () => ReplyJudgeProviderSnapshot;

/** Generic OpenAI-compatible chat-completions adapter. It has no tools or retry policy. */
export class OpenAICompatibleReplyJudge implements ReplyJudge {
    constructor(private readonly captureSnapshot: CaptureReplyJudgeSnapshot) {}

    async judge(request: ReplyJudgeRequest) {
        const snapshot = this.captureSnapshot();
        if (
            snapshot.provider !== "openai-compatible" ||
            !snapshot.model ||
            !snapshot.baseURL ||
            !snapshot.apiKey
        ) {
            throw new TenBotError("F:A_RJ_JRF");
        }

        const model = snapshot.model;
        logger.debug("[ReplyJudge] start provider=openai-compatible model=" + model +
            " revision=" + snapshot.prompt.revision);
        try {
            const client = new OpenAI({
                apiKey: snapshot.apiKey,
                baseURL: snapshot.baseURL,
                timeout: snapshot.timeoutMs,
                maxRetries: 0,
            });
            const completionRequest: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming & {
                enable_thinking: false;
            } = {
                model,
                temperature: 0,
                max_tokens: 32,
                enable_thinking: false,
                messages: [
                    { role: "system", content: snapshot.prompt.content },
                    { role: "user", content: JSON.stringify(request) },
                ],
            };
            const response = await client.chat.completions.create(completionRequest);
            const content = response.choices[0]?.message?.content;
            if (typeof content !== "string") return parseReplyJudgeOutput("");
            const decision = parseReplyJudgeOutput(content);
            logger.debug("[ReplyJudge] decision=" + decision.decision);
            return decision;
        } catch (error) {
            if (error instanceof TenBotError) throw error;
            throw new TenBotError("F:A_RJ_JRF", {
                safeDetails: { provider: "openai-compatible" },
            });
        }
    }
}
