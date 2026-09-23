import { randomUUID } from "node:crypto";
import type { QQBot } from "@tencent-connect/qqbot-nodejs";

import { AI_MODEL, chat } from "../../ai/client.js";
import type { AiResult, QuotePreference } from "../../ai/reply-result.js";
import { logger } from "../../shared/logger.js";
import { getMessageRevision, rememberBotReply } from "../conversation/recent-context.js";
import { markConversationActive, stopConversation } from "../conversation/engagement.js";
import type { NormalizedQqMessage } from "../message/normalize-message.js";
import { getTriggerMessageId, sendAiReply, sendTimeoutReply } from "./sender.js";

export const AI_REQUEST_TIMEOUT_MS = 30_000;
export const AI_TIMEOUT_REPLY = "后端卡住了，等会再叫我一下";
const AI_ERROR_REPLY = "刚才脑子短路了一下。";

type PendingRequestStatus = "running" | "completed" | "timed_out" | "failed";

interface PendingRequest {
    requestId: string;
    status: PendingRequestStatus;
    triggerMessageId?: string;
    conversationKey: string;
    triggerTimestamp?: string;
    revisionAtStart: number;
    controller: AbortController;
    timer?: ReturnType<typeof setTimeout>;
}

export interface ReplyRequest {
    bot: QQBot;
    message: NormalizedQqMessage;
    aiInput: string;
    imageUrls: string[];
    isGroup: boolean;
    allowNoReply: boolean;
    onWebSearchStart: () => void | Promise<void>;
}

const pendingRequests = new Map<string, PendingRequest>();

/** Test seams; production always uses the fixed 30-second deadline and SDK client. */
interface CoordinatorDependencies {
    executeAi?: typeof chat;
    timeoutMs?: number;
}

class AiTimeoutError extends Error {
    constructor() {
        super("AI request deadline exceeded");
    }
}

class LateResultError extends Error {
    constructor() {
        super("Late AI result discarded");
    }
}

/** New user messages override quote=none for group replies. */
export function shouldQuoteTrigger(
    preference: QuotePreference,
    isGroup: boolean,
    newerMessages: number,
    hasTriggerId: boolean,
): boolean {
    return hasTriggerId &&
        (preference === "trigger" || (isGroup && newerMessages > 0));
}

function quoteDecision(
    request: ReplyRequest,
    pending: PendingRequest,
    preference: QuotePreference,
): boolean {
    const newerMessages = Math.max(
        0,
        getMessageRevision(request.message) - pending.revisionAtStart,
    );
    const quote = shouldQuoteTrigger(
        preference,
        request.isGroup,
        newerMessages,
        Boolean(pending.triggerMessageId),
    );

    if (quote && newerMessages > 0) {
        logger.info(`[Reply] quoted trigger because ${newerMessages} newer messages arrived`);
    } else if (quote) {
        logger.info("[Reply] quoted trigger by qq_reply");
    } else if (request.isGroup && newerMessages > 0 && !pending.triggerMessageId) {
        logger.error("[Reply] cannot quote: trigger message id missing");
    }
    return quote;
}

async function sendFailureNotice(request: ReplyRequest, text: string): Promise<void> {
    try {
        await request.bot.sendText(request.message.replyTarget, text);
    } catch (error) {
        logger.error("[QQ] send error", error);
    }
}

export async function coordinateAiReply(
    request: ReplyRequest,
    dependencies: CoordinatorDependencies = {},
): Promise<void> {
    const requestId = randomUUID();
    const timeoutMs = dependencies.timeoutMs ?? AI_REQUEST_TIMEOUT_MS;
    const executeAi = dependencies.executeAi ?? chat;
    const pending: PendingRequest = {
        requestId,
        status: "running",
        triggerMessageId: getTriggerMessageId(request.message),
        conversationKey: request.isGroup
            ? `group:${request.message.groupId ?? "unknown"}`
            : `private:${request.message.authorId ?? "unknown"}`,
        triggerTimestamp: request.message.timestamp,
        revisionAtStart: getMessageRevision(request.message),
        controller: new AbortController(),
    };
    pendingRequests.set(requestId, pending);
    const logId = requestId.slice(0, 8);
    logger.info(
        `[AI] start request=${logId} model=${AI_MODEL} vision=${request.imageUrls.length} noReply=${request.allowNoReply ? "yes" : "no"}`,
    );
    logger.debug("[AI request]", {
        requestId,
        conversation: pending.conversationKey,
        triggerTimestamp: pending.triggerTimestamp,
        revisionAtStart: pending.revisionAtStart,
    });

    let rejectDeadline: (reason: AiTimeoutError) => void = () => {};
    const deadline = new Promise<never>((_resolve, reject) => {
        rejectDeadline = reject;
    });
    pending.timer = setTimeout(() => {
        if (pending.status !== "running") {
            return;
        }
        pending.status = "timed_out";
        logger.error(`[AI] timeout ${(timeoutMs / 1000).toFixed(1)}s request=${logId}`);
        pending.controller.abort();
        rejectDeadline(new AiTimeoutError());
    }, timeoutMs);

    const aiWork = executeAi(request.aiInput, {
        signal: pending.controller.signal,
        imageUrls: request.imageUrls,
        onWebSearchStart: async () => {
            if (pending.status === "running") {
                await request.onWebSearchStart();
            }
        },
    }).then(
        (result) => {
            if (pending.status !== "running") {
                logger.info(`[AI] late result discarded request=${logId}`);
                throw new LateResultError();
            }
            return result;
        },
        (error: unknown) => {
            if (pending.status === "timed_out") {
                logger.info(`[AI] aborted request=${logId}`);
            }
            throw error;
        },
    );

    let outcome:
        | { kind: "result"; result: AiResult }
        | { kind: "timeout" }
        | { kind: "error"; error: unknown };

    try {
        const result = await Promise.race([aiWork, deadline]);
        if (pending.status !== "running") {
            outcome = { kind: "timeout" };
        } else {
            pending.status = "completed";
            outcome = { kind: "result", result };
        }
    } catch (error) {
        if (pending.status === "timed_out" || error instanceof AiTimeoutError) {
            outcome = { kind: "timeout" };
        } else {
            pending.status = "failed";
            outcome = { kind: "error", error };
        }
    } finally {
        if (pending.timer) {
            clearTimeout(pending.timer);
            pending.timer = undefined;
        }
        pendingRequests.delete(requestId);
    }

    if (outcome.kind === "timeout") {
        const quote = quoteDecision(request, pending, "auto");
        try {
            await sendTimeoutReply(request.bot, request.message, AI_TIMEOUT_REPLY, quote);
            rememberBotReply(request.message, AI_TIMEOUT_REPLY);
            logger.info("[Reply] sent timeout notice");
        } catch (error) {
            logger.error("[QQ] timeout notice send error", error);
        }
        return;
    }

    if (outcome.kind === "error") {
        if (outcome.error instanceof LateResultError) {
            return;
        }
        logger.error("[AI] error", outcome.error);
        await sendFailureNotice(request, AI_ERROR_REPLY);
        return;
    }

    const result = outcome.result;
    if (result.kind === "no_reply") {
        logger.info("[AI] no reply");
        if (request.isGroup) {
            stopConversation(request.message);
        }
        return;
    }

    const quote = quoteDecision(request, pending, result.action.quote);
    try {
        const contextText = await sendAiReply(
            request.bot,
            request.message,
            result.action,
            quote,
        );
        rememberBotReply(request.message, contextText);
        logger.info("[Reply] sent");
        if (request.isGroup) {
            markConversationActive(request.message);
        }
    } catch (error) {
        logger.error("[QQ] send error", error);
    }
}
