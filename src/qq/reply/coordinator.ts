import { randomUUID } from "node:crypto";
import type { QQBot } from "@tencent-connect/qqbot-nodejs";
import { chat, runModelPlugin } from "../../ai/client.js";
import type { ModelPlugin } from "../../ai/model-plugin.js";
import { captureAttemptRuntimeSnapshot, type AttemptRuntimeSnapshot } from "../../ai/attempt-snapshot.js";
import { ToolProtocolLeakError } from "../../ai/tool-protocol.js";
import type { AiResult } from "../../ai/reply-result.js";
import type { MemeRuntimeSnapshot } from "../../skills/meme/store.js";
import { normalizeQQReplyAction, type QuotePreference } from "../../skills/qq-reply/skill.js";
import { AiResponseFailure, classifyUpstreamFailure } from "../../ai/upstream-error.js";
import { ModelAbortedError, ModelProviderError } from "../../ai/model-plugin.js";
import { TenBotError, isTenBotError } from "../../errors/tenbot-error.js";
import { findExplicitHttpStatus, mapConfirmedRemoteHttpError } from "../../errors/http-mapping.js";
import { toPublicErrorMessage } from "../../errors/format.js";
import { createQqSendError } from "./error-adapter.js";
import { logger, shortId } from "../../shared/logger.js";
import {
    automatedPeerLoopGuard,
    BOT_LOOP_GUARD_NOTICE,
    type AutomatedPeerLoopGuard,
} from "../conversation/automated-peer.js";
import { getConversationKey, getMessageRevision, rememberBotReply, removeMessageFromContext } from "../conversation/recent-context.js";
import { getConversationGeneration, markConversationActive, stopConversation } from "../conversation/engagement.js";
import type { NormalizedQqMessage } from "../message/normalize-message.js";
import type { TriggerKind } from "../message/trigger.js";
import { wakeLevelRank, type FrontMode, type WakeAdmission, type WakeLevel, type WakeReason } from "../../front/wake-level.js";
import { prepareAiReply } from "./renderer.js";
import { getTriggerMessageId, sendAiReply, sendTimeoutReply } from "./sender.js";

export const AI_REQUEST_TIMEOUT_MS = 30_000;
export const AI_WEB_SEARCH_TIMEOUT_MS = 120_000;
export const MAX_GENERATION_INTERRUPTS = 3;
export const MAX_TIMEOUT_RETRIES = 1;
export const MULTI_MESSAGE_DELAY_MS = 450;
const AI_ERROR_REPLY = "\u521a\u624d\u8111\u5b50\u77ed\u8def\u4e86\u4e00\u4e0b\u3002";

export type TriggerPriority = 0 | 1 | 2 | 3;
export interface ReplyCycleAnchor { revision: number; message: NormalizedQqMessage }
interface TrailingUpdate {
    anchor: ReplyCycleAnchor;
    priority: TriggerPriority;
    wakeLevel?: WakeLevel;
    wakeReason?: WakeReason;
    admission?: WakeAdmission;
    frontMode?: FrontMode;
    admitted?: boolean;
}
export interface AttemptInput { aiInput: string; imageUrls: string[]; refs?: Map<string, string>; memeSnapshot?: MemeRuntimeSnapshot }
export interface AttemptBuildContext {
    snapshotRevision: number;
    allowNoReply: boolean;
    frontMode: FrontMode;
    wakeLevel: WakeLevel;
    wakeReason?: WakeReason;
    admission?: WakeAdmission;
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
    frontMode?: FrontMode;
    wakeLevel: WakeLevel;
    wakeReason?: WakeReason;
    admission?: WakeAdmission;
    triggerKind?: TriggerKind;
    messageRevision?: number;
    onWebSearchStart: () => void | Promise<void>;
    triggerPriority?: TriggerPriority;
    isAtBot?: boolean;
    mentionedByName?: boolean;
    buildAttempt?: (message: NormalizedQqMessage, context: AttemptBuildContext) => Promise<AttemptInput>;
}
export interface ReplyCoordinatorDependencies {
    executeAi?: typeof chat;
    modelPlugin?: ModelPlugin;
    timeoutMs?: number;
    webSearchTimeoutMs?: number;
    multiMessageDelayMs?: number;
    botLoopGuard?: AutomatedPeerLoopGuard;
    /** Injectable snapshot source for deterministic offline runtime tests. */
    captureAttemptSnapshot?: () => AttemptRuntimeSnapshot;
}

export interface ProviderErrorSignal {
    provider: string;
    model: string;
    error: unknown;
}

export interface ReplyLifecycleSignal {
    kind: "started" | "interrupted" | "completed" | "failed" | "reply-sent";
    conversationKey: string;
    displayName?: string;
    cycleId: string;
    attemptId: string;
    attemptNumber: number;
    timestamp: string;
    content?: string;
    failureStage?: "generation" | "send";
}

type ProviderErrorListener = (signal: ProviderErrorSignal) => void;
const providerErrorListeners = new Set<ProviderErrorListener>();
type ReplyLifecycleListener = (signal: ReplyLifecycleSignal) => void;
const replyLifecycleListeners = new Set<ReplyLifecycleListener>();

export function subscribeReplyLifecycle(listener: ReplyLifecycleListener): () => void {
    replyLifecycleListeners.add(listener);
    return () => replyLifecycleListeners.delete(listener);
}

function publishReplyLifecycle(cycle: Cycle, attempt: Attempt, signal: Pick<ReplyLifecycleSignal, "kind" | "content" | "failureStage">): void {
    const event: ReplyLifecycleSignal = {
        ...signal,
        conversationKey: cycle.key,
        displayName: cycle.latestRequest.message.authorName,
        cycleId: cycle.cycleId,
        attemptId: attempt.requestId,
        attemptNumber: attempt.attemptNumber,
        timestamp: new Date().toISOString(),
    };
    for (const listener of replyLifecycleListeners) {
        try { listener(event); } catch { /* Observation must never change Reply Cycle behavior. */ }
    }
}

export function subscribeProviderErrors(listener: ProviderErrorListener): () => void {
    providerErrorListeners.add(listener);
    return () => providerErrorListeners.delete(listener);
}

function publishProviderError(signal: ProviderErrorSignal): void {
    for (const listener of providerErrorListeners) {
        try { listener(signal); } catch { /* Observers must not change Reply Cycle behavior. */ }
    }
}
type Dependencies = ReplyCoordinatorDependencies;
type AttemptStatus = "running" | "interrupted" | "completed" | "sending" | "timed_out" | "cancelled" | "failed";
type StopReason = "interrupted" | "timeout" | "cancelled";
interface Attempt {
    requestId: string;
    attemptNumber: number;
    snapshotRevision: number;
    startedAt: number;
    deadlineAt: number;
    controller: AbortController;
    modelPlugin: ModelPlugin;
    runtimeSnapshot: AttemptRuntimeSnapshot;
    refs: Map<string, string>;
    hasUsedWebSearch: boolean;
    status: AttemptStatus;
    resolveStop: (reason: StopReason) => void;
    stop: Promise<StopReason>;
    timer?: ReturnType<typeof setTimeout>;
}
interface Cycle {
    cycleId: string;
    key: string;
    anchorMessageId?: string;
    anchorRevision: number;
    interruptionCount: number;
    timeoutRetryCount: number;
    attemptNumber: number;
    cycleStartedAt: number;
    deadlineAt: number;
    webSearchTriggered: boolean;
    currentAttempt?: Attempt;
    consumedRevision: number;
    latestRequest: ReplyRequest;
    frontMode: FrontMode;
    priority: TriggerPriority;
    wakeLevel: WakeLevel;
    wakeReason?: WakeReason;
    admission?: WakeAdmission;
    originTriggerKind?: TriggerKind;
    effectiveTriggerKind?: TriggerKind;
    originAnchor: ReplyCycleAnchor;
    effectiveAnchor: ReplyCycleAnchor;
    updates: ReplyCycleAnchor[];
    lastAttemptSnapshotRevision: number;
    engagementGeneration?: number;
    hasAtBot: boolean;
    hasName: boolean;
    trailingUpdates: TrailingUpdate[];
    triggerIds: Set<string>;
    seenMessageIds: Set<string>;
    deps: Dependencies;
    cancelled: boolean;
    finalizing: boolean;
    budgetLogged: boolean;
    done: Promise<void>;
    resolveDone: () => void;
}
const cycles = new Map<string, Cycle>();
const triggerCycles = new Map<string, Set<string>>();
let acceptingCycles = true;

function addTrigger(cycle: Cycle, message: NormalizedQqMessage, priority: TriggerPriority): void {
    const id = getTriggerMessageId(message);
    if (!id || !priority || cycle.triggerIds.has(id)) return;
    cycle.triggerIds.add(id);
    let ids = triggerCycles.get(id);
    if (!ids) triggerCycles.set(id, ids = new Set());
    ids.add(cycle.cycleId);
}
function clearCycle(cycle: Cycle): void {
    if (cycle.currentAttempt?.timer) clearTimeout(cycle.currentAttempt.timer);
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
function clearAttemptTimer(attempt: Attempt): void {
    if (attempt.timer) clearTimeout(attempt.timer);
    attempt.timer = undefined;
}
function expireAttempt(cycle: Cycle, attempt: Attempt): void {
    if (cycle.currentAttempt !== attempt || cycle.finalizing || cycle.cancelled || attempt.status !== "running") return;
    attempt.status = "timed_out";
    clearAttemptTimer(attempt);
    attempt.controller.abort();
    resolveStop(attempt, "timeout");
    logger.info("[AI] timeout provider=" + attempt.modelPlugin.id + " request=" + shortId(attempt.requestId) + " attempt=" + attempt.attemptNumber +
        " revision=" + attempt.snapshotRevision);
}
function armAttemptDeadline(cycle: Cycle, attempt: Attempt): void {
    clearAttemptTimer(attempt);
    attempt.timer = setTimeout(() => expireAttempt(cycle, attempt), Math.max(0, attempt.deadlineAt - Date.now()));
}
function extendForWebSearch(cycle: Cycle): void {
    const attempt = cycle.currentAttempt;
    if (!attempt || attempt.status !== "running" || cycle.webSearchTriggered || cycle.finalizing || cycle.cancelled) return;
    if (Date.now() >= cycle.deadlineAt) {
        expireAttempt(cycle, attempt);
        return;
    }
    cycle.webSearchTriggered = true;
    const extended = cycle.deps.webSearchTimeoutMs ?? AI_WEB_SEARCH_TIMEOUT_MS;
    cycle.deadlineAt = cycle.cycleStartedAt + extended;
    attempt.hasUsedWebSearch = true;
    attempt.deadlineAt = cycle.deadlineAt;
    armAttemptDeadline(cycle, attempt);
    logger.info("[Cycle] Web Search deadline=" + Math.round(extended / 1000) + "s from cycle start");
}
function priorityOf(request: ReplyRequest): TriggerPriority {
    if (request.wakeLevel === "hard") return 3;
    if (request.wakeLevel === "pass") return 0;
    return request.wakeReason === "name-soft" || request.wakeReason === "quoted-bot" ? 2 : 1;
}
function wakeReasonOf(request: ReplyRequest, level: WakeLevel): WakeReason | undefined {
    if (request.wakeReason) return request.wakeReason;
    if (request.triggerKind === "name-soft") return "name-soft";
    if (request.triggerKind === "active-soft") return "active-soft";
    if (request.triggerKind === "quoted-bot") return "quoted-bot";
    if (level === "hard") return "hard-mention";
    if (level === "soft") return "reply-judge";
    return undefined;
}
function triggerKindOf(request: ReplyRequest, priority: TriggerPriority): TriggerKind | undefined {
    if (request.wakeReason) return request.wakeReason;
    if (request.triggerKind) return request.triggerKind;
    return kindOf(priority, request.isGroup);
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
        cycle.effectiveTriggerKind = triggerKindOf(request, priority);
        if (previous && cycle.effectiveTriggerKind) logger.info("[Cycle] trigger upgrade " + previous + " -> " + cycle.effectiveTriggerKind);
    }
    cycle.hasAtBot ||= request.isAtBot === true;
    cycle.hasName ||= request.mentionedByName === true;
}
function applyWakeAdmission(cycle: Cycle, request: ReplyRequest, priority: TriggerPriority, incoming: ReplyCycleAnchor): void {
    const incomingLevel = request.wakeLevel;
    const incomingReason = wakeReasonOf(request, incomingLevel);
    if (wakeLevelRank(incomingLevel) > wakeLevelRank(cycle.wakeLevel)) {
        cycle.wakeLevel = incomingLevel;
        cycle.wakeReason = incomingReason;
        cycle.admission = request.admission ?? (incomingLevel === "hard" ? "hard-mention" : "reply-judge");
    } else if (incomingLevel === cycle.wakeLevel && priority > cycle.priority) {
        cycle.wakeReason = incomingReason;
    }
    upgradeTrigger(cycle, request, priority, incoming);
}
function canNoReply(cycle: Cycle): boolean { return cycle.wakeLevel === "soft"; }
function buildAttemptContext(cycle: Cycle, revision: number): AttemptBuildContext {
    return { snapshotRevision: revision, allowNoReply: canNoReply(cycle), frontMode: cycle.frontMode, wakeLevel: cycle.wakeLevel,
        wakeReason: cycle.wakeReason, admission: cycle.admission, triggerPriority: cycle.priority,
        originTriggerKind: cycle.originTriggerKind, effectiveTriggerKind: cycle.effectiveTriggerKind,
        originAnchor: cycle.originAnchor, effectiveAnchor: cycle.effectiveAnchor,
        newerMessages: cycle.updates.filter((item) =>
            item.revision > cycle.lastAttemptSnapshotRevision && item.revision <= revision),
        isAtBot: cycle.hasAtBot, mentionedByName: cycle.hasName };
}
function admissionOf(request: ReplyRequest, wakeLevel: WakeLevel): WakeAdmission {
    if (request.admission) return request.admission;
    if (wakeLevel === "hard") return request.wakeReason === "private-message" ? "private-message" : "hard-mention";
    return request.wakeReason === "name-soft" || request.wakeReason === "active-soft" || request.wakeReason === "quoted-bot"
        ? request.wakeReason
        : "reply-judge";
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
    const wakeLevel = request.wakeLevel;
    const cycle: Cycle = {
        cycleId: randomUUID(), key: getConversationKey(request.message),
        anchorMessageId: getTriggerMessageId(request.message), anchorRevision: revision,
        interruptionCount: 0, timeoutRetryCount: 0, attemptNumber: 0, cycleStartedAt: started,
        deadlineAt: started + (deps.timeoutMs ?? AI_REQUEST_TIMEOUT_MS),
        webSearchTriggered: false, consumedRevision: revision - 1,
        latestRequest: request, frontMode: request.frontMode ?? "legacy", priority,
        originTriggerKind: triggerKindOf(request, originPriority),
        effectiveTriggerKind: triggerKindOf(request, priority),
        wakeLevel, wakeReason: wakeReasonOf(request, wakeLevel),
        admission: admissionOf(request, wakeLevel),
        originAnchor, effectiveAnchor, updates: trailingUpdates.slice(1).map((item) => item.anchor),
        lastAttemptSnapshotRevision: originAnchor.revision,
        engagementGeneration: request.isGroup ? getConversationGeneration(request.message) : undefined,
        hasAtBot: request.isAtBot === true,
        hasName: request.mentionedByName === true, trailingUpdates: [],
        triggerIds: new Set(), seenMessageIds: new Set(),
        deps, cancelled: false, finalizing: false, budgetLogged: false,
        done, resolveDone,
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
    const wakeLevel = request.wakeLevel;
    const admitted = wakeLevel !== "pass";
    cycle.latestRequest = request;
    addTrigger(cycle, request.message, priority);
    if (revision <= cycle.consumedRevision) return;
    cycle.trailingUpdates.push({
        anchor: incoming,
        priority,
        wakeLevel,
        wakeReason: wakeReasonOf(request, wakeLevel),
        admission: request.admission,
        frontMode: request.frontMode,
        admitted,
    });

    const attempt = cycle.currentAttempt;
    const currentCanRestart = !cycle.finalizing && cycle.interruptionCount < MAX_GENERATION_INTERRUPTS &&
        (!attempt || attempt.status === "interrupted" ||
            attempt.status === "running");
    if (currentCanRestart) {
        cycle.updates.push(incoming);
        if (admitted) applyWakeAdmission(cycle, request, priority, incoming);
        else upgradeTrigger(cycle, request, 0, incoming);
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
    publishReplyLifecycle(cycle, attempt, { kind: "interrupted" });
    clearAttemptTimer(attempt);
    logger.info("[AI] interrupted request=" + shortId(attempt.requestId) +
        " by revision=" + revision + " interrupt=" + cycle.interruptionCount + "/3");
    attempt.controller.abort();
    resolveStop(attempt, "interrupted");
}

/** Commits context changes and interrupts a stale Attempt before Reply Judge network I/O. */
export function observeConversationUpdate(request: ReplyRequest): void {
    if (!acceptingCycles) return;
    const active = cycles.get(getConversationKey(request.message));
    if (!active) return;
    updateCycle(active, {
        ...request,
        wakeLevel: "pass",
        wakeReason: undefined,
        admission: undefined,
        triggerPriority: 0,
    });
}

/** True while this conversation still owns a Reply Cycle lifecycle, including sending/finalizing. */
export function hasActiveReplyCycle(message: NormalizedQqMessage): boolean {
    return cycles.has(getConversationKey(message));
}

/** Admits only hard or Judge-accepted soft messages; pass never creates a new Cycle. */
export function admitConversationWake(
    request: ReplyRequest,
    wakeLevel: WakeLevel,
    wakeReason: WakeReason,
    dependencies: Dependencies = {},
): Promise<void> {
    if (!acceptingCycles || wakeLevel === "pass") {
        return cycles.get(getConversationKey(request.message))?.done ?? Promise.resolve();
    }
    const admission = admissionOf(request, wakeLevel);
    const acceptedRequest: ReplyRequest = {
        ...request,
        wakeLevel,
        wakeReason,
        admission,
        triggerPriority: undefined,
    };
    const priority = priorityOf(acceptedRequest);
    const active = cycles.get(getConversationKey(request.message));
    if (active) {
        const messageId = getTriggerMessageId(acceptedRequest.message);
        const alreadyObserved = Boolean(messageId && active.seenMessageIds.has(messageId));
        if (alreadyObserved) {
            active.latestRequest = acceptedRequest;
            const incoming = anchorOf(acceptedRequest);
            const queued = active.trailingUpdates.find((item) => item.anchor.revision === incoming.revision);
            if (queued) {
                queued.priority = Math.max(queued.priority, priority) as TriggerPriority;
                queued.wakeLevel = wakeLevel;
                queued.wakeReason = wakeReason;
                queued.admission = admission;
                queued.frontMode = request.frontMode;
                queued.admitted = true;
            }
            applyWakeAdmission(active, acceptedRequest, priority, incoming);
            return active.done;
        }
        updateCycle(active, acceptedRequest);
        return active.done;
    }
    return startNewCycle(acceptedRequest, dependencies, priority);
}
function startAttempt(cycle: Cycle, revision: number, refs: Map<string, string>): Attempt {
    let resolve!: (reason: StopReason) => void;
    const stop = new Promise<StopReason>((done) => { resolve = done; });
    const startedAt = Date.now();
    const deadlineAt = cycle.webSearchTriggered
        ? cycle.cycleStartedAt + (cycle.deps.webSearchTimeoutMs ?? AI_WEB_SEARCH_TIMEOUT_MS)
        : startedAt + (cycle.deps.timeoutMs ?? AI_REQUEST_TIMEOUT_MS);
    cycle.deadlineAt = deadlineAt;
    const runtimeSnapshot = cycle.deps.captureAttemptSnapshot?.() ?? captureAttemptRuntimeSnapshot(cycle.deps.modelPlugin);
    const modelPlugin = runtimeSnapshot.model.model;
    const attempt: Attempt = {
        requestId: randomUUID(), attemptNumber: ++cycle.attemptNumber,
        snapshotRevision: revision, startedAt, deadlineAt,
        controller: new AbortController(), modelPlugin,
        runtimeSnapshot,
        refs, hasUsedWebSearch: false,
        status: "running", resolveStop: resolve, stop,
    };
    cycle.currentAttempt = attempt;
    publishReplyLifecycle(cycle, attempt, { kind: "started" });
    cycle.lastAttemptSnapshotRevision = revision;
    cycle.trailingUpdates = [];
    cycle.budgetLogged = false;
    armAttemptDeadline(cycle, attempt);
    logger.info("[AI] start provider=" + modelPlugin.id + " model=" + modelPlugin.model +
        " request=" + shortId(attempt.requestId) +
        " attempt=" + attempt.attemptNumber + " snapshot=" + revision +
        " anchor=" + cycle.effectiveAnchor.revision);
    logger.debug(`[Prompt] attempt snapshot provider=${runtimeSnapshot.prompt.provider} revision=${runtimeSnapshot.prompt.revision}` +
        ` request=${shortId(attempt.requestId)} attempt=${attempt.attemptNumber}`);
    return attempt;
}
function clearAttempt(cycle: Cycle, attempt: Attempt): void {
    clearAttemptTimer(attempt);
    if (cycle.currentAttempt === attempt) cycle.currentAttempt = undefined;
}
function modelError(error: unknown, provider: string, attempt: number): TenBotError {
    if (isTenBotError(error)) return error;
    const status = findExplicitHttpStatus(error);
    const code = mapConfirmedRemoteHttpError("MP", status) ?? "M:A_MG_MRF";
    return new TenBotError(code, {
        cause: error,
        safeDetails: { provider, attempt, ...(status === undefined ? {} : { httpStatus: status }) },
    });
}

function isConfirmedModelProvider5xx(error: unknown): boolean {
    if (!(error instanceof ModelProviderError || error instanceof AiResponseFailure)) return false;
    return mapConfirmedRemoteHttpError("MP", findExplicitHttpStatus(error)) !== undefined;
}

async function sendFailureNotice(request: ReplyRequest, error: TenBotError): Promise<void> {
    logger.error(error);
    try {
        const message = toPublicErrorMessage(error);
        const sent = await request.bot.sendText(request.message.replyTarget, message);
        rememberBotReply(request.message, message, sent);
    }
    catch (sendError) { logger.error(createQqSendError(sendError, 0)); }
}

/** Front-stage fatal failures use the same public code formatting as Reply Cycle failures. */
export async function sendFrontFailureNotice(bot: QQBot, message: NormalizedQqMessage, error: TenBotError): Promise<void> {
    logger.error(error);
    try {
        const publicMessage = toPublicErrorMessage(error);
        const sent = await bot.sendText(message.replyTarget, publicMessage);
        rememberBotReply(message, publicMessage, sent);
    } catch (sendError) {
        logger.error(createQqSendError(sendError, 0));
    }
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
    } catch (error) { logger.error(createQqSendError(error, 0)); }
}

async function sendErrorFallback(
    request: ReplyRequest,
    cycle: Cycle,
    error: TenBotError,
    label: "timeout" | "upstream",
): Promise<void> {
    logger.error(error);
    await sendFallback(request, cycle, toPublicErrorMessage(error), label);
}

async function sendNonErrorNotice(request: ReplyRequest, text: string): Promise<void> {
    try { await request.bot.sendText(request.message.replyTarget, text); }
    catch (error) { logger.error(createQqSendError(error, 0)); }
}
async function sendBotLoopNotice(request: ReplyRequest): Promise<void> {
    try {
        await request.bot.sendText(request.message.replyTarget, BOT_LOOP_GUARD_NOTICE);
        rememberBotReply(request.message, BOT_LOOP_GUARD_NOTICE);
        logger.info("[BotLoop] local notice sent");
    } catch (error) {
        logger.error("[BotLoop] local notice send error", error);
    }
}
function webSearchCallback(request: ReplyRequest, cycle: Cycle, attempt: Attempt): () => Promise<void> {
    return async () => {
        if (cycle.currentAttempt !== attempt || attempt.status !== "running") return;
        if (!cycle.webSearchTriggered) {
            extendForWebSearch(cycle);
            if (attempt.status !== "running" || !cycle.webSearchTriggered) return;
            logger.info("[AI] web search");
            await request.onWebSearchStart();
        }
    };
}
type WorkResult = { kind: "result"; value: AiResult } | { kind: "error"; error: unknown };
type AttemptResult = WorkResult | { kind: StopReason };
async function runAttempt(cycle: Cycle, request: ReplyRequest, input: AttemptInput, attempt: Attempt): Promise<AttemptResult> {
    const work: Promise<WorkResult> = Promise.resolve()
        .then(() => {
            const options = { signal: attempt.controller.signal, imageUrls: input.imageUrls,
                memeSnapshot: input.memeSnapshot,
                onWebSearchStart: webSearchCallback(request, cycle, attempt) };
            return cycle.deps.executeAi
                ? cycle.deps.executeAi(input.aiInput, options)
                : runModelPlugin(attempt.modelPlugin, input.aiInput, options, attempt.runtimeSnapshot.prompt);
        })
        .then((value): WorkResult => {
            if (attempt.status === "running") {
                attempt.status = "completed";
                clearAttemptTimer(attempt);
            }
            return { kind: "result", value };
        }, (error: unknown): WorkResult => {
            if (attempt.status === "running") {
                attempt.status = "failed";
                clearAttemptTimer(attempt);
            }
            return { kind: "error", error };
        });
    const outcome = await Promise.race([
        work,
        attempt.stop.then((kind): AttemptResult => ({ kind })),
    ]);
    if (outcome.kind === "error") {
        if (attempt.status === "interrupted") return { kind: "interrupted" };
        if (attempt.status === "cancelled") return { kind: "cancelled" };
        if (attempt.status === "timed_out") return { kind: "timeout" };
    }
    if (outcome.kind === "interrupted") return outcome;
    if (outcome.kind === "cancelled" || outcome.kind === "timeout") return outcome;
    if (Date.now() >= attempt.deadlineAt && attempt.status === "completed") {
        attempt.status = "running";
        expireAttempt(cycle, attempt);
        return { kind: "timeout" };
    }
    return outcome;
}
function cancelCycle(cycle: Cycle): boolean {
    const attempt = cycle.currentAttempt;
    if (!attempt || (attempt.status !== "running" && attempt.status !== "sending")) return false;
    cycle.cancelled = true;
    attempt.status = "cancelled";
    clearAttemptTimer(attempt);
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
        if (!canNoReply(cycle)) {
            publishReplyLifecycle(cycle, attempt, { kind: "failed", failureStage: "generation" });
            await sendNonErrorNotice(request, AI_ERROR_REPLY);
            return;
        }
        logger.info("[AI] no reply");
        publishReplyLifecycle(cycle, attempt, { kind: "completed" });
        if (cycle.effectiveTriggerKind === "active-soft" && cycle.engagementGeneration !== undefined &&
            cycles.get(cycle.key) === cycle) stopConversation(request.message, cycle.engagementGeneration);
        return;
    }
    const action = normalizeQQReplyAction(result.action);
    if (!action) {
        publishReplyLifecycle(cycle, attempt, { kind: "failed", failureStage: "generation" });
        await sendFailureNotice(request, new TenBotError("B:A_RA_IRA"));
        return;
    }

    attempt.status = "sending";
    clearAttemptTimer(attempt);
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
                if (!response.sent) { failed = true; break; }
                sent++;
                publishReplyLifecycle(cycle, attempt, { kind: "reply-sent", content: action.messages[index]?.content ?? "" });
                rememberBotReply(request.message, rendered.contextText, response);
                logger.info(action.messages.length === 1 ? "[Reply] sent" : "[Reply] sent " + sent + "/" + action.messages.length);
            } catch (error) {
                failed = true;
                logger.error(createQqSendError(error, sent));
                break;
            }
        }
    } catch (error) { failed = true; logger.error("[Reply] render error", error); }
    finally {
        if (attempt.status === "sending") attempt.status = failed ? "failed" : "completed";
        if (attempt.status === "failed") publishReplyLifecycle(cycle, attempt, { kind: "failed", failureStage: "send" });
        else if (attempt.status === "completed") publishReplyLifecycle(cycle, attempt, { kind: "completed" });
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
        const trailingUpdates = cycle.trailingUpdates.filter((item) => item.anchor.revision > cycle.consumedRevision);
        const admittedUpdates = trailingUpdates.filter((item) => item.admitted === true && item.wakeLevel !== "pass");
        const admittedPriority = admittedUpdates.reduce<number>((highest, item) => Math.max(highest, item.priority), 0);
        const priority = admittedPriority as TriggerPriority;
        const atBot = admittedUpdates.some((item) => item.anchor.message.mentions.some((mention) => mention.isSelf) ||
            item.anchor.message.eventType === "GROUP_AT_MESSAGE_CREATE");
        const name = admittedUpdates.some((item) => item.anchor.message.displayContent.includes("小尘"));
        const wakeLevel: WakeLevel = admittedUpdates.some((item) => item.wakeLevel === "hard") ? "hard" : "soft";
        const wakeReason = admittedUpdates.find((item) => item.wakeLevel === "hard")?.wakeReason ??
            admittedUpdates[admittedUpdates.length - 1]?.wakeReason ?? "reply-judge";
        logger.info("[Cycle] consumed=" + cycle.consumedRevision + " current=" + revision);
        if (trailing) logger.info("[Cycle] trailing messages=" + (revision - cycle.consumedRevision));
        clearCycle(cycle);
        cycle.resolveDone();
        if (!trailing || cycle.cancelled) return;
        if (admittedUpdates.length === 0) return;
        const followup: ReplyRequest = { ...request,
            triggerPriority: priority, isAtBot: atBot, mentionedByName: name,
            triggerKind: wakeReason === "quoted-bot" ? "quoted-bot" : kindOf(priority, request.isGroup),
            wakeLevel,
            wakeReason,
            admission: admittedUpdates.find((item) => item.wakeLevel === "hard")?.admission ??
                admittedUpdates[admittedUpdates.length - 1]?.admission ?? (wakeLevel === "hard" ? "hard-mention" : "reply-judge"),
            frontMode: admittedUpdates[admittedUpdates.length - 1]?.frontMode ?? cycle.frontMode };
        void startNewCycle(followup, cycle.deps, priority, trailingUpdates, true);
    });
}
async function executeCycle(cycle: Cycle): Promise<void> {
    try {
        while (!cycle.cancelled) {
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
                if (cycle.cancelled) return;
                if (cycle.latestRequest === request && getMessageRevision(request.message) === revision) break;
            }
            cycle.trailingUpdates = [];
            const attempt = startAttempt(cycle, revision, input.refs ?? new Map());
            const outcome = await runAttempt(cycle, request, input, attempt);
            if (outcome.kind === "interrupted" && !cycle.cancelled && cycle.currentAttempt === attempt) {
                clearAttempt(cycle, attempt);
                logger.info("[AI] restart attempt=" + (cycle.attemptNumber + 1) +
                    " interrupt=" + cycle.interruptionCount + "/3 anchor=" + cycle.effectiveAnchor.revision +
                    " snapshot=" + getMessageRevision(cycle.latestRequest.message));
                continue;
            }
            if (outcome.kind === "cancelled" || cycle.cancelled) break;
            if (outcome.kind === "timeout") {
                attempt.status = "timed_out";
                publishReplyLifecycle(cycle, attempt, { kind: "failed", failureStage: "generation" });
                clearAttemptTimer(attempt);
                const currentRevision = getMessageRevision(cycle.latestRequest.message);
                if (attempt.hasUsedWebSearch || cycle.webSearchTriggered) {
                    logger.info("[AI] timeout retry skipped reason=web-search");
                } else if (currentRevision > attempt.snapshotRevision) {
                    logger.info("[AI] timeout retry skipped revision=" + attempt.snapshotRevision + "->" + currentRevision);
                } else if (cycle.timeoutRetryCount < MAX_TIMEOUT_RETRIES) {
                    cycle.timeoutRetryCount++;
                    clearAttempt(cycle, attempt);
                    logger.info("[AI] timeout retry " + cycle.timeoutRetryCount + "/" + MAX_TIMEOUT_RETRIES);
                    logger.info("[AI] restart attempt=" + (cycle.attemptNumber + 1) + " reason=timeout");
                    continue;
                } else {
                    logger.info("[AI] timeout retry exhausted");
                }
                cycle.consumedRevision = attempt.snapshotRevision;
                if (cycle.webSearchTriggered || !canNoReply(cycle)) {
                    await sendErrorFallback(request, cycle, new TenBotError("M:A_MG_MTO", {
                        safeDetails: { provider: attempt.modelPlugin.id, attempt: attempt.attemptNumber },
                    }), "timeout");
                } else logger.info("[Cycle] soft timeout silent");
                break;
            }
            if (outcome.kind === "error") {
                const abortName = outcome.error !== null && typeof outcome.error === "object" &&
                    "name" in outcome.error && (outcome.error as { name?: unknown }).name === "AbortError";
                if (attempt.controller.signal.aborted && (outcome.error instanceof ModelAbortedError || abortName)) {
                    logger.info("[AI] aborted request=" + shortId(attempt.requestId));
                    break;
                }
                attempt.status = "failed";
                publishReplyLifecycle(cycle, attempt, { kind: "failed", failureStage: "generation" });
                cycle.consumedRevision = attempt.snapshotRevision;
                if (outcome.error instanceof ToolProtocolLeakError) {
                    await sendFailureNotice(request, outcome.error);
                    break;
                }
                const upstream = classifyUpstreamFailure(outcome.error);
                if (outcome.error instanceof ModelProviderError || upstream) {
                    publishProviderError({ provider: attempt.modelPlugin.id, model: attempt.modelPlugin.model, error: outcome.error });
                }
                const confirmedProvider5xx = isConfirmedModelProvider5xx(outcome.error);
                try {
                    if (upstream) {
                        logger.info("[AI] upstream error provider=" + attempt.modelPlugin.id + " status=" + (upstream.status ?? "unknown") + " retryable=yes");
                        await sendErrorFallback(request, cycle, modelError(outcome.error, attempt.modelPlugin.id, attempt.attemptNumber), "upstream");
                    } else {
                        await sendFailureNotice(request, modelError(outcome.error, attempt.modelPlugin.id, attempt.attemptNumber));
                    }
                } finally {
                    if (confirmedProvider5xx && cycle.engagementGeneration !== undefined) {
                        stopConversation(request.message, cycle.engagementGeneration);
                    }
                }
                break;
            }
            if (attempt.status !== "completed" || cycle.cancelled) break;
            cycle.consumedRevision = attempt.snapshotRevision;
            clearAttemptTimer(attempt);
            if (outcome.kind !== "result") break;
            await sendResult(cycle, request, attempt, outcome.value);
            break;
        }
    } catch (error) {
        cycle.consumedRevision = getMessageRevision(cycle.latestRequest.message);
        logger.error("[Cycle] error id=" + shortId(cycle.cycleId), error);
    }
    finally {
        if (cycle.currentAttempt) clearAttemptTimer(cycle.currentAttempt);
        finishCycle(cycle);
    }
}
/** Submits committed messages to a per-conversation, single-flight reply cycle. */
export function coordinateAiReply(request: ReplyRequest, dependencies: Dependencies = {}): Promise<void> {
    if (!acceptingCycles) return Promise.resolve();
    observeConversationUpdate(request);
    if (request.wakeLevel === "pass") {
        return cycles.get(getConversationKey(request.message))?.done ?? Promise.resolve();
    }
    return admitConversationWake(request, request.wakeLevel,
        wakeReasonOf(request, request.wakeLevel) ?? "reply-judge", dependencies);
}

function startNewCycle(request: ReplyRequest, dependencies: Dependencies, priority: TriggerPriority,
    trailingUpdates: readonly TrailingUpdate[] = [], isTrailing = false): Promise<void> {
    if (!acceptingCycles) return Promise.resolve();
    const decision = (dependencies.botLoopGuard ?? automatedPeerLoopGuard).beforeNewCycle(
        getConversationKey(request.message), request.message.authorId, request.message.authorName,
    );
    if (!decision.allowed) {
        return decision.sendNotice ? sendBotLoopNotice(request) : Promise.resolve();
    }
    const cycle = createCycle(request, dependencies, priority, trailingUpdates);
    if (isTrailing) logger.info("[Cycle] next id=" + shortId(cycle.cycleId));
    void executeCycle(cycle);
    return cycle.done;
}

export function getActiveReplyCycleCount(): number {
    return cycles.size;
}

export async function shutdownReplyCoordinator(): Promise<void> {
    acceptingCycles = false;
    const active = [...cycles.values()];
    for (const cycle of active) {
        cycle.cancelled = true;
        const attempt = cycle.currentAttempt;
        if (!attempt) continue;
        attempt.status = "cancelled";
        clearAttemptTimer(attempt);
        attempt.controller.abort();
        resolveStop(attempt, "cancelled");
    }
    await Promise.all(active.map((cycle) => cycle.done));
}
