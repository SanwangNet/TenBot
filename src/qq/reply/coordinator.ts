import { randomUUID } from "node:crypto";
import type { QQBot } from "@tencent-connect/qqbot-nodejs";

import { AI_MODEL, chat } from "../../ai/client.js";
import type { AiResult, QuotePreference } from "../../ai/reply-result.js";
import { classifyUpstreamFailure } from "../../ai/upstream-error.js";
import { logger, shortId } from "../../shared/logger.js";
import {
    getConversationKey,
    getMessageRevision,
    rememberBotReply,
    removeMessageFromContext,
} from "../conversation/recent-context.js";
import { markConversationActive, stopConversation } from "../conversation/engagement.js";
import type { NormalizedQqMessage } from "../message/normalize-message.js";
import { getTriggerMessageId, prepareAiReply, sendAiReply, sendTimeoutReply } from "./sender.js";

export const AI_REQUEST_TIMEOUT_MS = 30_000;
export const AI_TIMEOUT_REPLY = "后端卡住了，等会再叫我一下";
export const AI_UPSTREAM_ERROR_REPLY = "后端暂时炸了，等会再叫我一下";
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

/** A terminal state is chosen once, before any asynchronous final-send work. */
function transition(pending: PendingRequest, status: Exclude<PendingRequestStatus, "running">): boolean {
    if (pending.status !== "running") return false;
    pending.status = status;
    if (pending.timer) {
        clearTimeout(pending.timer);
        pending.timer = undefined;
    }
    return true;
}

/** Cancels all still-running requests triggered by this QQ message. Idempotent. */
export function cancelPendingRequestByMessageId(messageId: string): number {
    if (!messageId) return 0;
    let cancelled = 0;
    for (const requestId of [...(pendingByTrigger.get(messageId) ?? [])]) {
        const pending = pendingRequests.get(requestId);
        if (!pending || !transition(pending, "cancelled")) continue;
        releasePending(pending);
        pending.controller.abort();
        logger.info("[AI] aborted request=" + shortId(requestId));
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
        logger.info("[Reply] quote trigger newerMessages=" + newerMessages);
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

async function sendLocalFallback(
    request: ReplyRequest,
    pending: PendingRequest,
    content: string,
    label: "timeout" | "upstream",
): Promise<void> {
    const quote = quoteDecision(request, pending, "auto");
    try {
        await sendTimeoutReply(request.bot, request.message, content, quote);
        rememberBotReply(request.message, content);
        logger.info("[Reply] " + label + " fallback sent");
    } catch (error) {
        logger.error("[QQ] " + label + " fallback send error", error);
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
        scope: request.isGroup ? "group" : "private",
        triggerTimestamp: pending.triggerTimestamp,
        revisionAtStart: pending.revisionAtStart,
        startedAt: pending.startedAt,
    });

    let rejectDeadline: (reason: AiTimeoutError) => void = () => {};
    const deadline = new Promise<never>((_resolve, reject) => {
        rejectDeadline = reject;
    });
    const timeoutPending = () => {
        if (!transition(pending, "timed_out")) return;
        logger.error("[AI] timeout request=" + logId + " " + (timeoutMs / 1000).toFixed(1) + "s");
        pending.controller.abort();
        logger.info("[AI] aborted request=" + logId);
        rejectDeadline(new AiTimeoutError());
    };
    pending.timer = setTimeout(timeoutPending, timeoutMs);

    const aiWork = Promise.resolve().then(() => {
        if (pending.status !== "running") throw new AiCancelledError();
        return executeAi(request.aiInput, {
            signal: pending.controller.signal,
            imageUrls: request.imageUrls,
            onWebSearchStart: async () => {
                if (pending.status === "running") await request.onWebSearchStart();
            },
        });
    }).then(async (result) => {
        if (pending.status !== "running") {
            logger.info("[AI] late result discarded request=" + logId);
            throw new LateResultError();
        }
        const rendered = result.kind === "reply"
            ? await prepareAiReply(request.message, result.action)
            : undefined;
        if (pending.status !== "running") {
            logger.info("[AI] late result discarded request=" + logId);
            throw new LateResultError();
        }
        return { result, rendered };
    });

    type Outcome =
        | { kind: "result"; value: Awaited<typeof aiWork> }
        | { kind: "timeout" }
        | { kind: "cancelled" }
        | { kind: "error"; error: unknown };
    let outcome: Outcome;
    try {
        try {
            const value = await Promise.race([aiWork, deadline, cancellation]);
            // A busy event loop may resolve work before the overdue timer callback runs.
            if (pending.status === "running" && Date.now() - pending.startedAt >= timeoutMs) {
                timeoutPending();
            }
            outcome = pending.status === "running"
                ? { kind: "result", value }
                : pending.status === "cancelled"
                  ? { kind: "cancelled" }
                  : { kind: "timeout" };
        } catch (error) {
            if (pending.status === "cancelled" || error instanceof AiCancelledError) {
                outcome = { kind: "cancelled" };
            } else if (pending.status === "timed_out" || error instanceof AiTimeoutError) {
                outcome = { kind: "timeout" };
            } else {
                transition(pending, "failed");
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
            await sendLocalFallback(request, pending, AI_TIMEOUT_REPLY, "timeout");
            return;
        }
        if (outcome.kind === "error") {
            if (outcome.error instanceof LateResultError) return;
            const upstream = classifyUpstreamFailure(outcome.error);
            if (upstream) {
                logger.info("[AI] upstream error status=" + (upstream.status ?? "unknown") + " retryable=yes");
                await sendLocalFallback(request, pending, AI_UPSTREAM_ERROR_REPLY, "upstream");
                return;
            }
            logger.error("[AI] error", outcome.error);
            await sendFailureNotice(request);
            return;
        }
        if (pending.status !== "running") return;
        const { result, rendered } = outcome.value;
        if (result.kind === "no_reply") {
            if (!transition(pending, "completed")) return;
            logger.info("[AI] no reply");
            if (request.isGroup) stopConversation(request.message);
            return;
        }
        if (!rendered) return;
        const quote = quoteDecision(request, pending, result.action.quote);
        if (pending.status !== "running") return;
        try {
            let expiredAtSend = false;
            const sent = await sendAiReply(request.bot, request.message, rendered, quote,
                () => {
                    if (Date.now() - pending.startedAt >= timeoutMs) {
                        expiredAtSend = true;
                        timeoutPending();
                        return false;
                    }
                    return transition(pending, "completed");
                });
            if (!sent) {
                if (expiredAtSend) {
                    await sendLocalFallback(request, pending, AI_TIMEOUT_REPLY, "timeout");
                } else {
                    logger.info("[AI] late result discarded request=" + logId);
                }
                return;
            }
            rememberBotReply(request.message, rendered.contextText);
            logger.info("[Reply] sent");
            if (request.isGroup) markConversationActive(request.message);
        } catch (error) {
            logger.error("[QQ] send error", error);
        }
    } finally {
        releasePending(pending);
    }
}
