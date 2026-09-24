import { randomUUID } from "node:crypto";
import type { QQBot } from "@tencent-connect/qqbot-nodejs";
import { AI_MODEL, chat } from "../../ai/client.js";
import type { AiResult } from "../../ai/reply-result.js";
import { normalizeQQReplyAction, type QuotePreference } from "../../skills/qq-reply/skill.js";
import { classifyUpstreamFailure } from "../../ai/upstream-error.js";
import { logger, shortId } from "../../shared/logger.js";
import { getConversationKey, getMessageRevision, rememberBotReply, removeMessageFromContext } from "../conversation/recent-context.js";
import { getConversationGeneration, isConversationActive, markConversationActive, stopConversation } from "../conversation/engagement.js";
import type { NormalizedQqMessage } from "../message/normalize-message.js";
import type { TriggerKind } from "../message/trigger.js";
import { prepareAiReply } from "./renderer.js";
import { getTriggerMessageId, sendAiReply, sendTimeoutReply } from "./sender.js";

export const AI_REQUEST_TIMEOUT_MS = 30_000;
export const AI_WEB_SEARCH_TIMEOUT_MS = 120_000;
export const MAX_GENERATION_INTERRUPTS = 3;
export const MULTI_MESSAGE_DELAY_MS = 450;
export const AI_TIMEOUT_REPLY = "\u540e\u7aef\u5361\u4f4f\u4e86\uff0c\u7b49\u4f1a\u518d\u53eb\u6211\u4e00\u4e0b";
export const AI_WEB_SEARCH_TIMEOUT_REPLY = "\u56de\u590d\u65f6\u95f4\u8fc7\u957f\uff0c\u5df2\u88ab\u4e2d\u6b62";
export const AI_UPSTREAM_ERROR_REPLY = "\u540e\u7aef\u6682\u65f6\u70b8\u4e86\uff0c\u7b49\u4f1a\u518d\u53eb\u6211\u4e00\u4e0b";
const AI_ERROR_REPLY = "\u521a\u624d\u8111\u5b50\u77ed\u8def\u4e86\u4e00\u4e0b\u3002";

export type TriggerPriority = 0 | 1 | 2 | 3;
export interface ReplyCycleAnchor { revision: number; message: NormalizedQqMessage }
interface TrailingUpdate { anchor: ReplyCycleAnchor; priority: TriggerPriority }
export interface AttemptInput { aiInput: string; imageUrls: string[]; refs?: Map<string, string> }
export interface AttemptBuildContext {
    allowNoReply: boolean;
    triggerPriority: TriggerPriority;
    originTriggerKind?: TriggerKind;
    effectiveTriggerKind?: TriggerKind;
    originAnchor: ReplyCycleAnchor;
    effectiveAnchor: ReplyCycleAnchor;
    newerMessages: readonly ReplyCycleAnchor[];
    isAtBot: boolean;
    mentionedByName: boolean;
}
export interface ReplyRequest {
    bot: QQBot;
    message: NormalizedQqMessage;
    aiInput: string;
    imageUrls: string[];
    isGroup: boolean;
    allowNoReply: boolean;
    triggerKind?: TriggerKind;
    messageRevision?: number;
    onWebSearchStart: () => void | Promise<void>;
    triggerPriority?: TriggerPriority;
    isAtBot?: boolean;
    mentionedByName?: boolean;
    shouldStartCycle?: boolean;
    buildAttempt?: (message: NormalizedQqMessage, context: AttemptBuildContext) => Promise<AttemptInput>;
}
interface Dependencies {
    executeAi?: typeof chat;
    timeoutMs?: number;
    webSearchTimeoutMs?: number;
    multiMessageDelayMs?: number;
}
type AttemptStatus = "running" | "interrupted" | "completed" | "sending" | "timed_out" | "cancelled" | "failed";
type StopReason = "interrupted" | "timeout" | "cancelled";
interface Attempt {
    requestId: string;
    snapshotRevision: number;
    startedAt: number;
    controller: AbortController;
    refs: Map<string, string>;
    status: AttemptStatus;
    resolveStop: (reason: StopReason) => void;
    stop: Promise<StopReason>;
}
interface Cycle {
    cycleId: string;
    key: string;
    anchorMessageId?: string;
    anchorRevision: number;
    interruptionCount: number;
    cycleStartedAt: number;
    deadlineAt: number;
    webSearchTriggered: boolean;
    currentAttempt?: Attempt;
    consumedRevision: number;
    latestRequest: ReplyRequest;
    priority: TriggerPriority;
    originTriggerKind?: TriggerKind;
    effectiveTriggerKind?: TriggerKind;
    originAnchor: ReplyCycleAnchor;
    effectiveAnchor: ReplyCycleAnchor;
    updates: ReplyCycleAnchor[];
    lastAttemptSnapshotRevision: number;
    engagementGeneration?: number;
    hasAtBot: boolean;
    hasName: boolean;
    trailingPriority: TriggerPriority;
    trailingAtBot: boolean;
    trailingName: boolean;
    trailingUpdates: TrailingUpdate[];
    triggerIds: Set<string>;
    seenMessageIds: Set<string>;
    deps: Dependencies;
    timedOut: boolean;
    cancelled: boolean;
    finalizing: boolean;
    budgetLogged: boolean;
    timer?: ReturnType<typeof setTimeout>;
    timeout: Promise<void>;
    resolveTimeout: () => void;
    done: Promise<void>;
    resolveDone: () => void;
}
const cycles = new Map<string, Cycle>();
const triggerCycles = new Map<string, Set<string>>();

function addTrigger(cycle: Cycle, message: NormalizedQqMessage, priority: TriggerPriority): void {
    const id = getTriggerMessageId(message);
    if (!id || !priority || cycle.triggerIds.has(id)) return;
    cycle.triggerIds.add(id);
    let ids = triggerCycles.get(id);
    if (!ids) triggerCycles.set(id, ids = new Set());
    ids.add(cycle.cycleId);
}
function clearCycle(cycle: Cycle): void {
    if (cycle.timer) clearTimeout(cycle.timer);
    if (cycles.get(cycle.key) === cycle) cycles.delete(cycle.key);
    for (const id of cycle.triggerIds) {
        const ids = triggerCycles.get(id);
        ids?.delete(cycle.cycleId);
        if (!ids?.size) triggerCycles.delete(id);
    }
}
function waitBetweenMessages(ms: number, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    if (ms <= 0) return Promise.resolve(true);
    return new Promise((resolve) => {
        const finish = (ready: boolean) => {
            clearTimeout(timer);
            signal.removeEventListener("abort", abort);
            resolve(ready);
        };
        const abort = () => finish(false);
        const timer = setTimeout(() => finish(true), ms);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
    });
}
function resolveStop(attempt: Attempt, reason: StopReason): void { attempt.resolveStop(reason); }
function expireCycle(cycle: Cycle): void {
    if (cycle.finalizing || cycle.cancelled || cycle.timedOut) return;
    cycle.timedOut = true;
    const attempt = cycle.currentAttempt;
    if (attempt?.status === "running") {
        attempt.status = "timed_out";
        attempt.controller.abort();
        resolveStop(attempt, "timeout");
    }
    cycle.resolveTimeout();
    logger.error("[Cycle] deadline exceeded id=" + shortId(cycle.cycleId));
}
function armDeadline(cycle: Cycle): void {
    if (cycle.timer) clearTimeout(cycle.timer);
    cycle.timer = setTimeout(() => expireCycle(cycle), Math.max(0, cycle.deadlineAt - Date.now()));
}
function extendForWebSearch(cycle: Cycle): void {
    if (cycle.webSearchTriggered || cycle.finalizing || cycle.timedOut) return;
    if (Date.now() >= cycle.deadlineAt) {
        expireCycle(cycle);
        return;
    }
    cycle.webSearchTriggered = true;
    const ordinary = cycle.deps.timeoutMs ?? AI_REQUEST_TIMEOUT_MS;
    const extended = cycle.deps.webSearchTimeoutMs ?? AI_WEB_SEARCH_TIMEOUT_MS;
    cycle.deadlineAt = cycle.cycleStartedAt + extended;
    armDeadline(cycle);
    logger.info("[Cycle] deadline extended " + Math.round(ordinary / 1000) + "s -> " + Math.round(extended / 1000) + "s");
}
function priorityOf(request: ReplyRequest): TriggerPriority {
    if (request.triggerKind) return request.triggerKind === "hard-mention" ? 3
        : request.triggerKind === "name-soft" ? 2 : 1;
    return request.triggerPriority ?? (request.isGroup ? (request.allowNoReply ? 1 : 3) : 3);
}
function anchorOf(request: ReplyRequest): ReplyCycleAnchor {
    return { revision: request.messageRevision ?? getMessageRevision(request.message), message: request.message };
}
function kindOf(priority: TriggerPriority, isGroup: boolean): TriggerKind | undefined {
    if (!isGroup || !priority) return undefined;
    return priority === 3 ? "hard-mention" : priority === 2 ? "name-soft" : "active-soft";
}
function upgradeTrigger(cycle: Cycle, request: ReplyRequest, priority: TriggerPriority, incoming: ReplyCycleAnchor): void {
    const explicit = priority >= 2;
    if (explicit && priority >= cycle.priority) {
        const previous = cycle.effectiveAnchor.revision;
        cycle.effectiveAnchor = incoming;
        logger.info("[Cycle] anchor update revision=" + previous + " -> " + incoming.revision +
            " trigger=" + kindOf(priority, request.isGroup));
    }
    if (priority > cycle.priority) {
        const previous = cycle.effectiveTriggerKind;
        cycle.priority = priority;
        cycle.effectiveTriggerKind = kindOf(priority, request.isGroup);
        if (previous && cycle.effectiveTriggerKind) logger.info("[Cycle] trigger upgrade " + previous + " -> " + cycle.effectiveTriggerKind);
    }
    cycle.hasAtBot ||= request.isAtBot === true;
    cycle.hasName ||= request.mentionedByName === true;
}
function canNoReply(cycle: Cycle): boolean { return cycle.latestRequest.isGroup && cycle.effectiveTriggerKind !== "hard-mention"; }
function buildAttemptContext(cycle: Cycle, revision: number): AttemptBuildContext {
    return { allowNoReply: canNoReply(cycle), triggerPriority: cycle.priority,
        originTriggerKind: cycle.originTriggerKind, effectiveTriggerKind: cycle.effectiveTriggerKind,
        originAnchor: cycle.originAnchor, effectiveAnchor: cycle.effectiveAnchor,
        newerMessages: cycle.updates.filter((item) =>
            item.revision > cycle.lastAttemptSnapshotRevision && item.revision <= revision),
        isAtBot: cycle.hasAtBot, mentionedByName: cycle.hasName };
}
function semanticAnchorText(context: AttemptBuildContext, refs?: Map<string, string>): string {
    const byId = new Map<string, string>();
    for (const [ref, id] of refs ?? []) byId.set(id, ref);
    const describe = ({ message }: ReplyCycleAnchor): string => {
        const ref = message.id ? byId.get(message.id) : undefined;
        return `${ref ? `[${ref}] ` : ""}${message.authorName ?? "群友"}：${message.displayContent}`;
    };
    const origin = context.originAnchor;
    const effective = context.effectiveAnchor;
    const newer = context.newerMessages.filter((item) => item.revision !== effective.revision);
    return [
        "<reply_cycle_context>",
        "本轮最初因这条消息开始考虑参与：" + describe(origin),
        ...(effective.revision !== origin.revision ? ["当前更明确的参与邀请：" + describe(effective)] : []),
        ...(newer.length ? ["上次生成后新增的群聊内容：", ...newer.map(describe)] : []),
        "新增内容用于重新判断上下文，不会自动取代本轮的参与起因。请结合整段对话决定如何自然参与。",
        "</reply_cycle_context>",
    ].join("\n");
}
export function buildReplyCycleMemeQuery(context: AttemptBuildContext): string {
    const seen = new Set<number>();
    return [context.effectiveAnchor, ...context.newerMessages]
        .filter((item) => !seen.has(item.revision) && Boolean(seen.add(item.revision)))
        .map((item) => item.message.displayContent.trim())
        .filter(Boolean)
        .join("\n");
}
function createCycle(request: ReplyRequest, deps: Dependencies, priority: TriggerPriority,
    trailingUpdates: readonly TrailingUpdate[] = []): Cycle {
    let resolveTimeout!: () => void;
    const timeout = new Promise<void>((resolve) => { resolveTimeout = resolve; });
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });
    const started = Date.now();
    const originAnchor = trailingUpdates[0]?.anchor ?? anchorOf(request);
    const originPriority = trailingUpdates.length ? (trailingUpdates[0].priority || 1) : priority;
    let effectiveAnchor = originAnchor;
    let effectivePriority = originPriority;
    for (const item of trailingUpdates.slice(1)) {
        if (item.priority >= 2 && item.priority >= effectivePriority) {
            effectiveAnchor = item.anchor;
            effectivePriority = item.priority;
        }
    }
    const revision = request.messageRevision ?? getMessageRevision(request.message);
    const cycle: Cycle = {
        cycleId: randomUUID(), key: getConversationKey(request.message),
        anchorMessageId: getTriggerMessageId(request.message), anchorRevision: revision,
        interruptionCount: 0, cycleStartedAt: started,
        deadlineAt: started + (deps.timeoutMs ?? AI_REQUEST_TIMEOUT_MS),
        webSearchTriggered: false, consumedRevision: revision - 1,
        latestRequest: request, priority, originTriggerKind: kindOf(originPriority, request.isGroup),
        effectiveTriggerKind: kindOf(priority, request.isGroup),
        originAnchor, effectiveAnchor, updates: trailingUpdates.slice(1).map((item) => item.anchor),
        lastAttemptSnapshotRevision: originAnchor.revision,
        engagementGeneration: request.isGroup ? getConversationGeneration(request.message) : undefined,
        hasAtBot: request.isAtBot === true,
        hasName: request.mentionedByName === true, trailingPriority: 0,
        trailingAtBot: false, trailingName: false, trailingUpdates: [],
        triggerIds: new Set(), seenMessageIds: new Set(),
        deps, timedOut: false, cancelled: false, finalizing: false, budgetLogged: false,
        timeout, resolveTimeout, done, resolveDone,
    };
    const anchorId = getTriggerMessageId(request.message);
    if (anchorId) cycle.seenMessageIds.add(anchorId);
    addTrigger(cycle, request.message, priority);
    for (const item of trailingUpdates) {
        const id = getTriggerMessageId(item.anchor.message);
        if (id) cycle.seenMessageIds.add(id);
        addTrigger(cycle, item.anchor.message, item.priority);
    }
    cycles.set(cycle.key, cycle);
    logger.info("[Cycle] start id=" + shortId(cycle.cycleId) + " revision=" + revision +
        " trigger=" + (cycle.originTriggerKind ?? "private") +
        " reply=" + (canNoReply(cycle) ? "optional" : "required") + " anchor=" + originAnchor.revision);
    return cycle;
}
function updateCycle(cycle: Cycle, request: ReplyRequest): void {
    const messageId = getTriggerMessageId(request.message);
    if (messageId && cycle.seenMessageIds.has(messageId)) return;
    if (messageId) cycle.seenMessageIds.add(messageId);
    const incoming = anchorOf(request);
    const revision = incoming.revision;
    const priority = priorityOf(request);
    cycle.latestRequest = request;
    addTrigger(cycle, request.message, priority);
    if (revision <= cycle.consumedRevision) return;
    cycle.trailingPriority = Math.max(cycle.trailingPriority, priority) as TriggerPriority;
    cycle.trailingAtBot ||= request.isAtBot === true;
    cycle.trailingName ||= request.mentionedByName === true;
    cycle.trailingUpdates.push({ anchor: incoming, priority });

    const attempt = cycle.currentAttempt;
    const currentCanRestart = !cycle.finalizing && cycle.interruptionCount < MAX_GENERATION_INTERRUPTS &&
        (!attempt || attempt.status === "interrupted" ||
            attempt.status === "running");
    if (currentCanRestart) {
        cycle.updates.push(incoming);
        upgradeTrigger(cycle, request, priority, incoming);
    }
    if (cycle.finalizing || !attempt || attempt.status !== "running") return;
    if (cycle.interruptionCount >= MAX_GENERATION_INTERRUPTS) {
        if (!cycle.budgetLogged) {
            cycle.budgetLogged = true;
            logger.info("[AI] interrupt budget exhausted 3/3, buffering newer messages");
        }
        return;
    }
    cycle.interruptionCount++;
    attempt.status = "interrupted";
    logger.info("[AI] interrupted request=" + shortId(attempt.requestId) +
        " by revision=" + revision + " interrupt=" + cycle.interruptionCount + "/3");
    attempt.controller.abort();
    resolveStop(attempt, "interrupted");
}
function startAttempt(cycle: Cycle, revision: number, refs: Map<string, string>): Attempt {
    let resolve!: (reason: StopReason) => void;
    const stop = new Promise<StopReason>((done) => { resolve = done; });
    const attempt: Attempt = {
        requestId: randomUUID(), snapshotRevision: revision, startedAt: Date.now(),
        controller: new AbortController(), refs, status: "running", resolveStop: resolve, stop,
    };
    cycle.currentAttempt = attempt;
    cycle.lastAttemptSnapshotRevision = revision;
    cycle.trailingPriority = 0;
    cycle.trailingAtBot = false;
    cycle.trailingName = false;
    cycle.trailingUpdates = [];
    cycle.budgetLogged = false;
    logger.info("[AI] start request=" + shortId(attempt.requestId) + " model=" + AI_MODEL +
        " attempt=" + (cycle.interruptionCount + 1) + " snapshot=" + revision +
        " anchor=" + cycle.effectiveAnchor.revision);
    return attempt;
}
function clearAttempt(cycle: Cycle, attempt: Attempt): void {
    if (cycle.currentAttempt === attempt) cycle.currentAttempt = undefined;
}
async function sendFailureNotice(request: ReplyRequest): Promise<void> {
    try { await request.bot.sendText(request.message.replyTarget, AI_ERROR_REPLY); }
    catch (error) { logger.error("[QQ] send error", error); }
}
function cycleReplyMessage(cycle: Cycle, request: ReplyRequest): NormalizedQqMessage {
    return cycle.anchorMessageId ? { ...request.message, id: cycle.anchorMessageId } : request.message;
}
async function sendFallback(request: ReplyRequest, cycle: Cycle, text: string, label: "timeout" | "upstream"): Promise<void> {
    const newer = Math.max(0, getMessageRevision(request.message) - cycle.anchorRevision);
    const quote = shouldQuoteTrigger("auto", request.isGroup, newer, Boolean(cycle.anchorMessageId));
    try {
        const sent = await sendTimeoutReply(request.bot, cycleReplyMessage(cycle, request), text, quote);
        rememberBotReply(request.message, text, sent);
        logger.info("[Reply] " + label + " fallback sent");
    } catch (error) { logger.error("[Reply] " + label + " fallback send error", error); }
}
function webSearchCallback(request: ReplyRequest, cycle: Cycle, attempt: Attempt): () => Promise<void> {
    return async () => {
        if (cycle.currentAttempt !== attempt || attempt.status !== "running") return;
        if (!cycle.webSearchTriggered) {
            extendForWebSearch(cycle);
            if (cycle.timedOut || !cycle.webSearchTriggered) return;
            logger.info("[AI] web search");
            await request.onWebSearchStart();
        }
    };
}
type WorkResult = { kind: "result"; value: AiResult } | { kind: "error"; error: unknown };
type AttemptResult = WorkResult | { kind: StopReason };
async function runAttempt(cycle: Cycle, request: ReplyRequest, input: AttemptInput, attempt: Attempt): Promise<AttemptResult> {
    const execute = cycle.deps.executeAi ?? chat;
    const work: Promise<WorkResult> = Promise.resolve()
        .then(() => execute(input.aiInput, { signal: attempt.controller.signal, imageUrls: input.imageUrls,
            onWebSearchStart: webSearchCallback(request, cycle, attempt) }))
        .then((value): WorkResult => {
            if (attempt.status === "running") attempt.status = "completed";
            return { kind: "result", value };
        }, (error: unknown): WorkResult => {
            if (attempt.status === "running") attempt.status = "failed";
            return { kind: "error", error };
        });
    const outcome = await Promise.race([
        work,
        attempt.stop.then((kind): AttemptResult => ({ kind })),
        cycle.timeout.then((): AttemptResult => ({ kind: "timeout" })),
    ]);
    if (outcome.kind === "interrupted") {
        // Let an aborted stream settle before restarting, but never keep the cycle
        // alive past its deadline when an upstream promise ignores abort.
        await Promise.race([work, cycle.timeout]);
        return cycle.timedOut ? { kind: "timeout" } : outcome;
    }
    if (outcome.kind === "cancelled" || outcome.kind === "timeout") return outcome;
    if (Date.now() >= cycle.deadlineAt && cycle.deadlineAt <= Date.now() && !cycle.timedOut) {
        cycle.timedOut = true;
        attempt.controller.abort();
        cycle.resolveTimeout();
        return { kind: "timeout" };
    }
    return outcome;
}
function cancelCycle(cycle: Cycle): boolean {
    const attempt = cycle.currentAttempt;
    if (!attempt || (attempt.status !== "running" && attempt.status !== "sending")) return false;
    cycle.cancelled = true;
    attempt.status = "cancelled";
    attempt.controller.abort();
    resolveStop(attempt, "cancelled");
    return true;
}
export function cancelPendingRequestByMessageId(messageId: string): number {
    if (!messageId) return 0;
    let count = 0;
    for (const cycleId of [...(triggerCycles.get(messageId) ?? [])]) {
        const cycle = [...cycles.values()].find((item) => item.cycleId === cycleId);
        if (!cycle || !cancelCycle(cycle)) continue;
        const attempt = cycle.currentAttempt!;
        logger.info("[AI] cancelled by recall request=" + shortId(attempt.requestId));
        count++;
    }
    return count;
}
export function handleRecalledMessage(conversationKey: string, messageId: string): void {
    const cancelled = cancelPendingRequestByMessageId(messageId);
    const removed = removeMessageFromContext(conversationKey, messageId);
    if (cancelled || removed) logger.info("[Recall] message=" + shortId(messageId));
}
export function shouldQuoteTrigger(preference: QuotePreference | "auto" | "trigger" | "none", isGroup: boolean, newer: number, hasId: boolean): boolean {
    const mode = typeof preference === "string" ? preference : preference.mode;
    return hasId && (mode === "trigger" || (mode === "auto" && isGroup && newer > 0));
}
function quoteDecision(request: ReplyRequest, cycle: Cycle, attempt: Attempt, preference: QuotePreference): string | undefined {
    if (preference.mode === "message") {
        const safeRef = /^m[1-9]\d{0,5}$/.test(preference.ref) ? preference.ref : "[malformed]";
        logger.debug("[Reply] quote selected ref=" + safeRef);
        const id = safeRef !== "[malformed]" ? attempt.refs.get(safeRef) : undefined;
        if (id) {
            logger.debug("[Reply] quote resolved ref=" + safeRef);
            return id;
        }
        logger.debug("[Reply] invalid quote ref=" + safeRef + ", fallback=auto");
    } else if (preference.mode === "none") return undefined;
    const newer = Math.max(0, getMessageRevision(request.message) - cycle.anchorRevision);
    const quote = shouldQuoteTrigger("auto", request.isGroup, newer, Boolean(cycle.anchorMessageId || getTriggerMessageId(request.message)));
    if (quote && newer > 0) logger.info("[Reply] quote trigger newerMessages=" + newer);
    return quote ? cycle.anchorMessageId ?? getTriggerMessageId(request.message) : undefined;
}
async function sendResult(cycle: Cycle, request: ReplyRequest, attempt: Attempt, result: AiResult): Promise<void> {
    if (cycle.cancelled || cycle.currentAttempt !== attempt || attempt.status !== "completed") return;
    if (result.kind === "no_reply") {
        if (!canNoReply(cycle)) { await sendFailureNotice(request); return; }
        logger.info("[AI] no reply");
        if (cycle.effectiveTriggerKind === "active-soft" && cycle.engagementGeneration !== undefined &&
            cycles.get(cycle.key) === cycle) stopConversation(request.message, cycle.engagementGeneration);
        return;
    }
    const action = normalizeQQReplyAction(result.action);
    if (!action) { await sendFailureNotice(request); return; }

    attempt.status = "sending";
    if (cycle.timer) clearTimeout(cycle.timer);
    cycle.timer = undefined;
    // Freeze every transport target before the first send or 450ms delay.
    const quoteIds = action.messages.map((message) => quoteDecision(request, cycle, attempt, message.quote));
    let sent = 0;
    let failed = false;
    const delay = cycle.deps.multiMessageDelayMs ?? MULTI_MESSAGE_DELAY_MS;
    try {
        for (let index = 0; index < action.messages.length; index++) {
            if (attempt.status !== "sending" || cycle.cancelled) break;
            if (index && !await waitBetweenMessages(delay, attempt.controller.signal)) break;
            if (attempt.status !== "sending" || cycle.cancelled) break;
            const rendered = await prepareAiReply(request.message, action, index);
            if (attempt.status !== "sending" || cycle.cancelled) break;
            try {
                const response = await sendAiReply(request.bot, request.message, rendered, quoteIds[index],
                    () => attempt.status === "sending" && !cycle.cancelled);
                if (!response.sent) break;
                sent++;
                rememberBotReply(request.message, rendered.contextText, response);
                logger.info(action.messages.length === 1 ? "[Reply] sent" : "[Reply] sent " + sent + "/" + action.messages.length);
            } catch (error) {
                failed = true;
                logger.error("[Reply] message " + (index + 1) + "/" + action.messages.length + " failed", error);
                break;
            }
        }
    } catch (error) { failed = true; logger.error("[Reply] render error", error); }
    finally {
        if (attempt.status === "sending") attempt.status = failed ? "failed" : "completed";
        if (sent > 0 && request.isGroup && cycles.get(cycle.key) === cycle) markConversationActive(request.message);
    }
}
function finishCycle(cycle: Cycle): void {
    if (cycle.finalizing) return;
    cycle.finalizing = true;
    queueMicrotask(() => {
        const revision = getMessageRevision(cycle.latestRequest.message);
        const trailing = !cycle.cancelled && revision > cycle.consumedRevision;
        const request = cycle.latestRequest;
        const priority = cycle.trailingPriority || 1;
        const atBot = cycle.trailingAtBot;
        const name = cycle.trailingName;
        const trailingUpdates = cycle.trailingUpdates.filter((item) => item.anchor.revision > cycle.consumedRevision);
        logger.info("[Cycle] consumed=" + cycle.consumedRevision + " current=" + revision);
        if (trailing) logger.info("[Cycle] trailing messages=" + (revision - cycle.consumedRevision));
        clearCycle(cycle);
        cycle.resolveDone();
        if (!trailing || cycle.cancelled) return;
        if (!cycle.trailingPriority && request.isGroup && !isConversationActive(request.message)) return;
        const followup: ReplyRequest = { ...request, shouldStartCycle: true,
            triggerPriority: priority, isAtBot: atBot, mentionedByName: name,
            triggerKind: kindOf(priority, request.isGroup),
            allowNoReply: request.isGroup && priority < 3 };
        const next = createCycle(followup, cycle.deps, priority, trailingUpdates);
        logger.info("[Cycle] next id=" + shortId(next.cycleId));
        void executeCycle(next);
    });
}
async function executeCycle(cycle: Cycle): Promise<void> {
    try {
        armDeadline(cycle);
        while (!cycle.cancelled && !cycle.timedOut) {
            let request!: ReplyRequest;
            let input!: AttemptInput;
            let revision = 0;
            for (;;) {
                request = cycle.latestRequest;
                revision = getMessageRevision(request.message);
                const context = buildAttemptContext(cycle, revision);
                input = request.buildAttempt
                    ? await request.buildAttempt(request.message, context)
                    : { aiInput: request.aiInput, imageUrls: request.imageUrls };
                if (request.isGroup) input = { ...input,
                    aiInput: input.aiInput + "\n" + semanticAnchorText(context, input.refs) };
                if (cycle.cancelled || cycle.timedOut) return;
                if (cycle.latestRequest === request && getMessageRevision(request.message) === revision) break;
            }
            cycle.trailingPriority = 0;
            cycle.trailingAtBot = false;
            cycle.trailingName = false;
            cycle.trailingUpdates = [];
            const attempt = startAttempt(cycle, revision, input.refs ?? new Map());
            const outcome = await runAttempt(cycle, request, input, attempt);
            if (outcome.kind === "interrupted" && !cycle.timedOut && !cycle.cancelled) {
                clearAttempt(cycle, attempt);
                logger.info("[AI] restart attempt=" + (cycle.interruptionCount + 1) +
                    " interrupt=" + cycle.interruptionCount + "/3 anchor=" + cycle.effectiveAnchor.revision +
                    " snapshot=" + getMessageRevision(cycle.latestRequest.message));
                continue;
            }
            if (outcome.kind === "cancelled" || cycle.cancelled) break;
            if (outcome.kind === "timeout" || cycle.timedOut) {
                attempt.status = "timed_out";
                cycle.consumedRevision = attempt.snapshotRevision;
                if (cycle.webSearchTriggered || !canNoReply(cycle)) {
                    await sendFallback(request, cycle,
                        cycle.webSearchTriggered ? AI_WEB_SEARCH_TIMEOUT_REPLY : AI_TIMEOUT_REPLY, "timeout");
                } else logger.info("[Cycle] soft timeout silent");
                break;
            }
            if (outcome.kind === "error") {
                attempt.status = "failed";
                cycle.consumedRevision = attempt.snapshotRevision;
                const upstream = classifyUpstreamFailure(outcome.error);
                if (upstream) {
                    logger.info("[AI] upstream error status=" + (upstream.status ?? "unknown") + " retryable=yes");
                    await sendFallback(request, cycle, AI_UPSTREAM_ERROR_REPLY, "upstream");
                } else {
                    logger.error("[AI] error", outcome.error);
                    await sendFailureNotice(request);
                }
                break;
            }
            if (attempt.status !== "completed" || cycle.cancelled) break;
            cycle.consumedRevision = attempt.snapshotRevision;
            if (cycle.timer) clearTimeout(cycle.timer);
            cycle.timer = undefined;
            if (outcome.kind !== "result") break;
            await sendResult(cycle, request, attempt, outcome.value);
            break;
        }
    } catch (error) {
        cycle.consumedRevision = getMessageRevision(cycle.latestRequest.message);
        logger.error("[Cycle] error id=" + shortId(cycle.cycleId), error);
    }
    finally {
        if (cycle.timer) clearTimeout(cycle.timer);
        cycle.timer = undefined;
        finishCycle(cycle);
    }
}
/** Submits committed messages to a per-conversation, single-flight reply cycle. */
export function coordinateAiReply(request: ReplyRequest, dependencies: Dependencies = {}): Promise<void> {
    const key = getConversationKey(request.message);
    const active = cycles.get(key);
    if (active) {
        updateCycle(active, request);
        return active.done;
    }
    if (request.shouldStartCycle === false) return Promise.resolve();
    const cycle = createCycle(request, dependencies, priorityOf(request));
    void executeCycle(cycle);
    return cycle.done;
}
