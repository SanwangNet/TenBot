import { randomUUID } from "node:crypto";
import type { QQBot } from "@tencent-connect/qqbot-nodejs";

import { AI_MODEL, chat } from "../../ai/client.js";
import type { AiResult, QuotePreference } from "../../ai/reply-result.js";
import { logger, shortId } from "../../shared/logger.js";
import {
    getConversationKey,
    getMessageRevision,
    rememberBotReply,
    removeMessageFromContext,
} from "../conversation/recent-context.js";
import { markConversationActive, stopConversation } from "../conversation/engagement.js";
import type { NormalizedQqMessage } from "../message/normalize-message.js";
import { getTriggerMessageId, sendAiReply, sendTimeoutReply } from "./sender.js";

export const AI_REQUEST_TIMEOUT_MS = 30_000;
export const AI_TIMEOUT_REPLY = "后端卡住了，等会再叫我一下";
const AI_ERROR_REPLY = "刚才脑子短路了一下。";

type PendingRequestStatus = "running" | "completed" | "timed_out" | "cancelled" | "failed";

interface PendingRequest {
    requestId: string;
    status: PendingRequestStatus;
    triggerMessageId?: string;
    conversationKey: string;
    triggerTimestamp?: string;
    revisionAtStart: number;
    startedAt: number;
    controller: AbortController;
    timer?: ReturnType<typeof setTimeout>;
    rejectCancellation: (error: AiCancelledError) => void;
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

interface CoordinatorDependencies {
    executeAi?: typeof chat;
    timeoutMs?: number;
}

const pendingRequests = new Map<string, PendingRequest>();
const pendingByTrigger = new Map<string, Set<string>>();

class AiTimeoutError extends Error {
    constructor() { super("AI request deadline exceeded"); }
}
class AiCancelledError extends Error {
    constructor() { super("AI request cancelled by recall"); }
}
class LateResultError extends Error {
    constructor() { super("Late AI result discarded"); }
}

function registerPending(pending: PendingRequest): void {
    pendingRequests.set(pending.requestId, pending);
    if (!pending.triggerMessageId) return;
    let ids = pendingByTrigger.get(pending.triggerMessageId);
    if (!ids) {
        ids = new Set();
        pendingByTrigger.set(pending.triggerMessageId, ids);
    }
    ids.add(pending.requestId);
}

function releasePending(pending: PendingRequest): void {
    if (pending.timer) {
        clearTimeout(pending.timer);
        pending.timer = undefined;
    }
    pendingRequests.delete(pending.requestId);
    if (pending.triggerMessageId) {
        const ids = pendingByTrigger.get(pending.triggerMessageId);
        ids?.delete(pending.requestId);
        if (ids?.size === 0) pendingByTrigger.delete(pending.triggerMessageId);
    }
}

/** Cancels all still-running requests triggered by this QQ message. Idempotent. */
export function cancelPendingRequestByMessageId(messageId: string): number {
    if (!messageId) return 0;
    let cancelled = 0;
    for (const requestId of [...(pendingByTrigger.get(messageId) ?? [])]) {
        const pending = pendingRequests.get(requestId);
        if (!pending || pending.status !== "running") continue;
        pending.status = "cancelled";
        releasePending(pending);
        pending.controller.abort();
        pending.rejectCancellation(new AiCancelledError());
        cancelled += 1;
        logger.info("[AI] cancelled by recall request=" + shortId(requestId));
    }
    return cancelled;
}

/** Ready for a real recall event if the platform exposes one in the future. */
export function handleRecalledMessage(conversationKey: string, messageId: string): void {
    const cancelled = cancelPendingRequestByMessageId(messageId);
    const removed = removeMessageFromContext(conversationKey, messageId);
    if (cancelled || removed) {
        logger.info("[Recall] message=" + shortId(messageId));
    }
}

export function shouldQuoteTrigger(
    preference: QuotePreference,
    isGroup: boolean,
    newerMessages: number,
    hasTriggerId: boolean,
): boolean {
    return hasTriggerId &&
        (preference === "trigger" || (isGroup && newerMessages > 0));
}

function quoteDecision(request: ReplyRequest, pending: PendingRequest, preference: QuotePreference): boolean {
    const newerMessages = Math.max(
        0,
        getMessageRevision(request.message) - pending.revisionAtStart,
    );
    const quote = shouldQuoteTrigger(
        preference, request.isGroup, newerMessages, Boolean(pending.triggerMessageId),
    );
    if (quote && newerMessages > 0) {
        logger.info("[Reply] quoted trigger because " + newerMessages + " newer messages arrived");
    } else if (quote) {
        logger.info("[Reply] quoted trigger by qq_reply");
    } else if (request.isGroup && newerMessages > 0 && !pending.triggerMessageId) {
        logger.error("[Reply] cannot quote: trigger message id missing");
    }
    return quote;
}

async function sendFailureNotice(request: ReplyRequest): Promise<void> {
    try {
        await request.bot.sendText(request.message.replyTarget, AI_ERROR_REPLY);
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
    let rejectCancellation: (error: AiCancelledError) => void = () => {};
    const cancellation = new Promise<never>((_resolve, reject) => {
        rejectCancellation = reject;
    });
    const pending: PendingRequest = {
        requestId,
        status: "running",
        triggerMessageId: getTriggerMessageId(request.message),
        conversationKey: getConversationKey(request.message),
        triggerTimestamp: request.message.timestamp,
        revisionAtStart: getMessageRevision(request.message),
        startedAt: Date.now(),
        controller: new AbortController(),
        rejectCancellation,
    };
    registerPending(pending);
    const logId = shortId(requestId);
    logger.info(
        "[AI] start request=" + logId + " model=" + AI_MODEL +
        " vision=" + request.imageUrls.length +
        " noReply=" + (request.allowNoReply ? "yes" : "no"),
    );
    logger.debug("[AI request]", {
        requestId,
        conversation: pending.conversationKey,
        triggerTimestamp: pending.triggerTimestamp,
        revisionAtStart: pending.revisionAtStart,
        startedAt: pending.startedAt,
    });

    let rejectDeadline: (reason: AiTimeoutError) => void = () => {};
    const deadline = new Promise<never>((_resolve, reject) => {
        rejectDeadline = reject;
    });
    pending.timer = setTimeout(() => {
        if (pending.status !== "running") return;
        pending.status = "timed_out";
        logger.error("[AI] timeout " + (timeoutMs / 1000).toFixed(1) + "s request=" + logId);
        pending.controller.abort();
        rejectDeadline(new AiTimeoutError());
    }, timeoutMs);

    const aiWork = Promise.resolve().then(() => {
        if (pending.status !== "running") throw new AiCancelledError();
        return executeAi(request.aiInput, {
            signal: pending.controller.signal,
            imageUrls: request.imageUrls,
            onWebSearchStart: async () => {
                if (pending.status === "running") await request.onWebSearchStart();
            },
        });
    }).then(
        (result) => {
            if (pending.status !== "running") {
                logger.info("[AI] late result discarded request=" + logId);
                throw new LateResultError();
            }
            return result;
        },
        (error: unknown) => {
            if (pending.status === "timed_out" || pending.status === "cancelled") {
                logger.info("[AI] aborted request=" + logId);
            }
            throw error;
        },
    );

    type Outcome =
        | { kind: "result"; result: AiResult }
        | { kind: "timeout" }
        | { kind: "cancelled" }
        | { kind: "error"; error: unknown };
    let outcome: Outcome;
    try {
        try {
            const result = await Promise.race([aiWork, deadline, cancellation]);
            outcome = pending.status === "running"
                ? { kind: "result", result }
                : pending.status === "cancelled"
                  ? { kind: "cancelled" }
                  : { kind: "timeout" };
        } catch (error) {
            if (pending.status === "cancelled" || error instanceof AiCancelledError) {
                outcome = { kind: "cancelled" };
            } else if (pending.status === "timed_out" || error instanceof AiTimeoutError) {
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
        }

        if (outcome.kind === "cancelled") return;
        if (outcome.kind === "timeout") {
            if (pending.status !== "timed_out") return;
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
            if (outcome.error instanceof LateResultError) return;
            logger.error("[AI] error", outcome.error);
            await sendFailureNotice(request);
            return;
        }
        if (pending.status !== "running") return;
        const result = outcome.result;
        if (result.kind === "no_reply") {
            pending.status = "completed";
            logger.info("[AI] no reply");
            if (request.isGroup) stopConversation(request.message);
            return;
        }
        const quote = quoteDecision(request, pending, result.action.quote);
        // Keep the request cancellable through the final synchronous send decision.
        if (pending.status !== "running") return;
        pending.status = "completed";
        try {
            const contextText = await sendAiReply(request.bot, request.message, result.action, quote);
            rememberBotReply(request.message, contextText);
            logger.info("[Reply] sent");
            if (request.isGroup) markConversationActive(request.message);
        } catch (error) {
            logger.error("[QQ] send error", error);
        }
    } finally {
        releasePending(pending);
    }
}
