import type {
    QQBot,
    QQBotInboundMessage,
} from "@tencent-connect/qqbot-nodejs";

import { buildAiInput, buildReplyPolicy } from "../../ai/input-builder.js";
import { buildReplyJudgeRequest } from "../../front/build-reply-judge-request.js";
import { decideFrontPolicy } from "../../front/front-policy.js";
import type { ReplyJudge, ReplyJudgeDecision, ReplyJudgeRequest } from "../../front/reply-judge.js";
import type { FrontMode } from "../../front/wake-level.js";
import type { ReplyCoordinatorDependencies, ReplyRequest } from "../reply/coordinator.js";
import { TenBotError, isTenBotError } from "../../errors/tenbot-error.js";
import { routeCommand } from "../../commands/router.js";
import { projectMemeCandidates } from "../../skills/meme/projection.js";
import { getMemeRuntimeSnapshot, searchAutoMemeCandidates } from "../../skills/meme/skill.js";
import type { MemeSearchQuery } from "../../skills/meme/search.js";
import { debugPeerIdentity, logger, shortId, truncateLogText } from "../../shared/logger.js";
import {
    buildReplyCycleSnapshot,
    getConversationKey,
    getMessageRevision,
    getRecentImages,
    rememberIncomingMessage,
    recordIncomingMessageRevision,
} from "../conversation/recent-context.js";
import { isConversationActive } from "../conversation/engagement.js";
import {
    automatedPeerLoopGuard,
    type AutomatedPeerLoopGuard,
} from "../conversation/automated-peer.js";
import { buildKnownMembersContext, rememberKnownMember } from "../conversation/known-members.js";
import { normalizeQqMessage } from "../message/normalize-message.js";
import { decideMessageTrigger, isOnlyQQFace, wantsVision } from "../message/trigger.js";
import { admitConversationWake, hasActiveReplyCycle, observeConversationUpdate, sendFrontFailureNotice } from "../reply/coordinator.js";
import type { NormalizedQqMessage } from "../message/normalize-message.js";

const SEARCH_NOTICES = [
    "\u7a0d\u7b49\uff0c\u6211\u67e5\u4e00\u4e0b\u3002",
    "\u6211\u641c\u4e00\u4e0b\u6700\u65b0\u7684\u3002",
    "\u8fd9\u4e2a\u5f97\u67e5\u4e00\u4e0b\uff0c\u6211\u770b\u770b\u3002",
    "\u6211\u53bb\u770b\u4e00\u773c\u73b0\u5728\u7684\u60c5\u51b5\u3002",
    "\u7b49\u6211\u7ffb\u4e00\u4e0b\u6700\u65b0\u8d44\u6599\u3002",
    "\u7a0d\u7b49\uff0c\u6211\u786e\u8ba4\u4e00\u4e0b\u3002",
];
function randomSearchNotice(): string {
    return SEARCH_NOTICES[Math.floor(Math.random() * SEARCH_NOTICES.length)];
}
function summarizeMessage(input: string, imageAttachments: any[]): string {
    if (isOnlyQQFace(input)) return "[QQ\u8868\u60c5]";
    if (input) return truncateLogText(input, 160);
    if (!imageAttachments.length) return "";
    const first = imageAttachments[0];
    if (first.width !== undefined && first.height !== undefined) {
        const dimensions = first.width + "x" + first.height;
        return imageAttachments.length === 1 ? "[\u56fe\u7247 " + dimensions + "]" : "[\u56fe\u7247 " + dimensions + " x" + imageAttachments.length + "]";
    }
    return "[\u56fe\u7247 x" + imageAttachments.length + "]";
}

export interface ReplyJudgeTurnWaitScheduler {
    setTimeout(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout>;
    clearTimeout(timer: ReturnType<typeof setTimeout>): void;
    unref?(timer: ReturnType<typeof setTimeout>): void;
}

const defaultTurnWaitScheduler: ReplyJudgeTurnWaitScheduler = {
    setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
    clearTimeout: (timer) => clearTimeout(timer),
    unref: (timer) => timer.unref?.(),
};

interface JudgeCandidate {
    request: ReplyRequest;
    revision: number;
    signals: Omit<ReplyJudgeRequest["signals"], "turnWaitExpired">;
    dependencies: ReplyCoordinatorDependencies;
}

interface JudgeAdmissionState {
    readonly key: string;
    latest: JudgeCandidate;
    phase: "judging" | "waiting-turn";
    generation: number;
    judgeInFlight: boolean;
    recheckInFlight: boolean;
    waitStartedAt?: number;
    waitRevision?: number;
    timer?: ReturnType<typeof setTimeout>;
}

function isReplyJudgeDecision(value: unknown): value is ReplyJudgeDecision {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return Object.keys(record).length === 1 &&
        (record.decision === "reply" || record.decision === "pass" || record.decision === "wait");
}

export function registerMessageHandler(
    bot: QQBot,
    loopGuard: AutomatedPeerLoopGuard = automatedPeerLoopGuard,
    observePeer?: (message: NormalizedQqMessage) => void,
    observeConversationMessage?: (message: NormalizedQqMessage) => void,
    replyJudge?: ReplyJudge,
    coordinatorDependencies: ReplyCoordinatorDependencies = {},
    getFrontMode: () => FrontMode = () => "legacy",
    getReplyJudgeIpoFallbackToMain: () => boolean = () => true,
    getReplyJudgeTurnWaitMs: () => number = () => 20_000,
    turnWaitScheduler: ReplyJudgeTurnWaitScheduler = defaultTurnWaitScheduler,
): () => void {
    const judgeAdmissionStates = new Map<string, JudgeAdmissionState>();
    let disposed = false;

    const clearAdmissionState = (key: string): void => {
        const state = judgeAdmissionStates.get(key);
        if (!state) return;
        if (state.timer) turnWaitScheduler.clearTimeout(state.timer);
        state.timer = undefined;
        state.generation++;
        judgeAdmissionStates.delete(key);
    };

    const dispose = (): void => {
        if (disposed) return;
        disposed = true;
        for (const state of judgeAdmissionStates.values()) {
            if (state.timer) turnWaitScheduler.clearTimeout(state.timer);
            state.timer = undefined;
            state.generation++;
        }
        judgeAdmissionStates.clear();
    };

    const runJudge = async (state: JudgeAdmissionState, turnWaitExpired: boolean): Promise<void> => {
        if (disposed || judgeAdmissionStates.get(state.key) !== state || state.judgeInFlight) return;
        state.judgeInFlight = true;
        let recheckExpired = turnWaitExpired;
        try {
            while (!disposed && judgeAdmissionStates.get(state.key) === state) {
                let candidate = state.latest;
                let revision = candidate.revision;
                const generation = state.generation;
                state.recheckInFlight = recheckExpired;
                let decision: ReplyJudgeDecision | undefined;
                let failure: unknown;
                try {
                    if (!replyJudge) throw new TenBotError("F:A_RJ_JRF");
                    const judgeRequest = buildReplyJudgeRequest(candidate.request.message, {
                        ...candidate.signals,
                        turnWaitExpired: recheckExpired,
                    });
                    decision = await replyJudge.judge(judgeRequest);
                    if (!isReplyJudgeDecision(decision)) throw new TenBotError("F:A_RJ_IPO");
                    if (recheckExpired && decision.decision === "wait") {
                        logger.debug("[ReplyJudge] wait is invalid after an expired turn wait");
                        throw new TenBotError("F:A_RJ_IPO");
                    }
                } catch (error) {
                    failure = error;
                }

                if (disposed || judgeAdmissionStates.get(state.key) !== state) return;
                if (state.generation !== generation) {
                    state.recheckInFlight = false;
                    recheckExpired = false;
                    continue;
                }
                // A normal in-flight Judge remains single-flight. If messages arrived while it was
                // running, apply its admission result to the newest committed message/context.
                if (state.latest.revision !== revision) {
                    candidate = state.latest;
                    revision = candidate.revision;
                }
                state.recheckInFlight = false;
                const currentRevision = getMessageRevision(candidate.request.message);
                if (currentRevision !== revision) {
                    if (state.latest.revision === revision) {
                        logger.debug(`[Front] stale Judge context discarded conversation=${shortId(state.key)} revision=${revision}->${currentRevision}`);
                        clearAdmissionState(state.key);
                        return;
                    }
                    recheckExpired = false;
                    continue;
                }

                const ipoFallback = failure instanceof TenBotError &&
                    failure.code === "F:A_RJ_IPO" && getReplyJudgeIpoFallbackToMain();
                if (failure && !ipoFallback) {
                    clearAdmissionState(state.key);
                    const frontError = isTenBotError(failure) ? failure : new TenBotError("F:A_RJ_JRF");
                    if (!hasActiveReplyCycle(candidate.request.message)) {
                        await sendFrontFailureNotice(bot, candidate.request.message, frontError);
                    }
                    return;
                }

                if (ipoFallback) {
                    logger.info("[ReplyJudge] invalid protocol output; falling back to main model");
                }
                const outcome = ipoFallback ? "reply" : decision?.decision;
                if (outcome === "pass") {
                    logger.debug("[ReplyJudge] decision=pass");
                    clearAdmissionState(state.key);
                    return;
                }
                if (outcome === "wait") {
                    state.phase = "waiting-turn";
                    state.recheckInFlight = false;
                    state.waitRevision = revision;
                    state.waitStartedAt = Date.now();
                    const waitGeneration = ++state.generation;
                    const waitMs = getReplyJudgeTurnWaitMs();
                    logger.debug(`[ReplyJudge] decision=wait`);
                    logger.debug(`[Front] turn wait started conversation=${shortId(state.key)} revision=${revision}`);
                    state.timer = turnWaitScheduler.setTimeout(() => {
                        if (disposed || judgeAdmissionStates.get(state.key) !== state ||
                            state.phase !== "waiting-turn" || state.generation !== waitGeneration) return;
                        state.timer = undefined;
                        const latestRevision = getMessageRevision(state.latest.request.message);
                        if (latestRevision !== state.waitRevision) {
                            logger.debug(`[Front] stale turn wait discarded conversation=${shortId(state.key)} revision=${state.waitRevision}->${latestRevision}`);
                            clearAdmissionState(state.key);
                            return;
                        }
                        state.phase = "judging";
                        state.recheckInFlight = true;
                        logger.debug(`[Front] turn wait expired; rechecking conversation=${shortId(state.key)} revision=${latestRevision}`);
                        void runJudge(state, true);
                    }, waitMs);
                    turnWaitScheduler.unref?.(state.timer);
                    return;
                }

                clearAdmissionState(state.key);
                if (hasActiveReplyCycle(candidate.request.message)) return;
                const reason = ipoFallback
                    ? "judge-invalid-output-fallback"
                    : candidate.request.triggerKind && candidate.request.triggerKind !== "hard-mention"
                        ? candidate.request.triggerKind
                        : "reply-judge";
                if (!ipoFallback) logger.debug("[ReplyJudge] decision=reply");
                await admitConversationWake({ ...candidate.request, admission: reason }, "soft", reason, candidate.dependencies);
                return;
            }
        } finally {
            state.judgeInFlight = false;
        }
    };

    bot.on("message", async (context, message: QQBotInboundMessage) => {
        if (disposed) return;
        const frontMode = getFrontMode();
        const normalized = await normalizeQqMessage(context, message);
        debugPeerIdentity(normalized.authorName, normalized.authorId);
        const isAutomatedPeer = loopGuard.isAutomatedPeer(normalized.authorId);
        // QQ's bot flag is not reliable membership policy; unregistered IDs fail open as human activity.

        const conversationKey = getConversationKey(normalized);
        if (isAutomatedPeer) loopGuard.observeAutomatedPeerMessage(conversationKey);
        else loopGuard.resetByHumanMessage(conversationKey, normalized.authorName);

        // Learn members and route native commands before they can affect an AI cycle.
        await rememberKnownMember(normalized);
        try { observePeer?.(normalized); }
        catch { /* The local TUI directory must not change message handling behavior. */ }
        if (await routeCommand(bot, normalized)) return;

        const input = normalized.displayContent;
        const imageAttachments = normalized.attachments.filter((attachment: any) => {
            const contentType = attachment?.content_type ?? attachment?.contentType;
            return typeof contentType === "string" && contentType.startsWith("image/");
        });
        const hasImages = imageAttachments.length > 0;
        if (!input && !hasImages) return;
        if (isOnlyQQFace(input)) {
            logger.info("[Filter] qq-face");
            return;
        }

        const isGroupEvent = normalized.kind === "group" ||
            normalized.eventType === "GROUP_MESSAGE_CREATE" ||
            normalized.eventType === "GROUP_AT_MESSAGE_CREATE";
        const speaker = normalized.authorName
            ? truncateLogText(normalized.authorName, 60)
            : shortId(normalized.authorId);
        const messageSummary = summarizeMessage(input, imageAttachments);
        if (messageSummary) logger.info("[" + (isGroupEvent ? "GROUP" : "C2C") + "] " + speaker + ": " + messageSummary);
        else logger.debug("[QQ message] empty content");
        logger.debug("[QQ normalized]", {
            kind: normalized.kind,
            eventType: normalized.eventType,
            author: speaker,
            content: input,
            mentions: normalized.mentions.map((mention) => ({ isYou: mention.isSelf, name: mention.username })),
            attachments: imageAttachments.map((attachment: any) => ({
                contentType: attachment?.content_type ?? attachment?.contentType,
                width: attachment?.width,
                height: attachment?.height,
            })),
        });

        const activeConversation = isGroupEvent ? isConversationActive(normalized) : false;
        const trigger = decideMessageTrigger(normalized, activeConversation);
        const frontDecision = decideFrontPolicy(frontMode, {
            isPrivateMessage: normalized.kind === "c2c" || normalized.kind === "dm",
            hardMention: trigger.isAtBot,
            nameMention: trigger.mentionedByName,
            conversationActive: trigger.activeConversation,
            quotedBot: normalized.quotedBot === true,
        });

        // Filtered QQ faces and local commands never increment revision or interrupt generation.
        const revision = recordIncomingMessageRevision(normalized);
        rememberIncomingMessage(normalized, input);
        try { observeConversationMessage?.(normalized); }
        catch { /* Timeline observation must not change message handling. */ }
        logger.debug("[Cycle] inbound revision=" + revision);

        if (!input && hasImages) {
            const firstImage = imageAttachments[0];
            logger.info(firstImage.width !== undefined && firstImage.height !== undefined
                ? "[Image] cached " + firstImage.width + "x" + firstImage.height
                : "[Image] cached");
        }

        const latestMessage = normalized;
        const request: ReplyRequest = {
            bot,
            message: normalized,
            aiInput: "",
            imageUrls: [],
            isGroup: trigger.isGroup,
            frontMode,
            wakeLevel: "pass",
            wakeReason: trigger.triggerKind === "hard-mention" ? undefined :
                trigger.triggerKind ?? "reply-judge",
            triggerKind: trigger.triggerKind ?? undefined,
            messageRevision: revision,
            isAtBot: trigger.isAtBot,
            mentionedByName: trigger.mentionedByName,
            onWebSearchStart: async () => {
                await bot.sendText(latestMessage.replyTarget, randomSearchNotice());
            },
            buildAttempt: async (attemptMessage, context) => {
                const memeSnapshot = getMemeRuntimeSnapshot();
                const snapshot = buildReplyCycleSnapshot(attemptMessage);
                const knownMembersContext = trigger.isGroup
                    ? await buildKnownMembersContext(attemptMessage)
                    : "";
                const memeQueries: MemeSearchQuery[] = [];
                const seenMemeRevisions = new Set<number>();
                for (const item of [
                    { anchor: context.effectiveAnchor, source: "anchor" as const },
                    ...context.newerMessages
                        .filter((item) => item.revision !== context.effectiveAnchor.revision)
                        .map((anchor) => ({ anchor, source: "new-message" as const })),
                ]) {
                    if (seenMemeRevisions.has(item.anchor.revision)) continue;
                    seenMemeRevisions.add(item.anchor.revision);
                    const text = item.anchor.message.displayContent.trim();
                    if (text) memeQueries.push({ text, source: item.source });
                }
                const memeCandidates = searchAutoMemeCandidates(memeQueries, undefined, memeSnapshot);
                const memeContext = projectMemeCandidates(memeCandidates);
                if (memeCandidates.length) {
                    const top = truncateLogText(memeCandidates[0].entry.name, 64);
                    logger.info(`[Meme] candidates=${memeCandidates.length} top=${JSON.stringify(top)}`);
                    memeCandidates.forEach((candidate, index) => {
                        logger.debug(`[Meme] #${index + 1} name=${JSON.stringify(truncateLogText(candidate.entry.name, 64))}` +
                            ` score=${candidate.score} strength=${candidate.strength.toLowerCase()}` +
                            ` source=${(candidate.matchedBy ?? []).join(",")}`);
                    });
                }
                const replyPolicy = buildReplyPolicy(context.allowNoReply);
                const aiInput = buildAiInput(snapshot.text, knownMembersContext, replyPolicy, memeContext);
                const frontDecision = [
                    "<front_decision>",
                    "trusted_by=TenBot Runtime",
                    "wake_level=" + context.wakeLevel,
                    "admission=" + (context.admission ?? "runtime"),
                    "reason=" + (context.wakeReason ?? "none"),
                    "front_mode=" + context.frontMode,
                    "</front_decision>",
                ].join("\n");
                const recentImageUrls = getRecentImages(attemptMessage, 1);
                const useVision = wantsVision(
                    attemptMessage.displayContent,
                    context.isAtBot,
                    context.mentionedByName,
                    recentImageUrls.length > 0,
                );
                return {
                    aiInput: frontDecision + "\n\n" + aiInput,
                    imageUrls: useVision ? recentImageUrls : [],
                    refs: snapshot.refs,
                    memeSnapshot,
                };
            },
        };
        const cycleDependencies = {
            ...coordinatorDependencies,
            botLoopGuard: coordinatorDependencies.botLoopGuard ?? loopGuard,
        };

        // This synchronous observation bumps/interupts the existing Cycle before any Judge I/O.
        observeConversationUpdate(request);

        if (hasActiveReplyCycle(normalized)) {
            clearAdmissionState(conversationKey);
            // A live Cycle owns ordinary follow-up context. Only a deterministic hard wake may upgrade it.
            if (frontDecision.kind === "admit" && frontDecision.wakeLevel === "hard") {
                logger.info(frontDecision.reason === "private-message"
                    ? "[Trigger] private message / hard"
                    : "[Trigger] mention / hard");
                await admitConversationWake({ ...request, admission: frontDecision.admission },
                    frontDecision.wakeLevel, frontDecision.reason, cycleDependencies);
            }
            return;
        }

        if (frontDecision.kind !== "judge") clearAdmissionState(conversationKey);

        if (frontDecision.kind === "admit") {
            if (frontDecision.wakeLevel === "hard") logger.info(frontDecision.reason === "private-message"
                ? "[Trigger] private message / hard"
                : "[Trigger] mention / hard");
            await admitConversationWake({ ...request, admission: frontDecision.admission },
                frontDecision.wakeLevel, frontDecision.reason, cycleDependencies);
            return;
        }
        if (frontDecision.kind === "pass") return;

        const candidate: JudgeCandidate = {
            request,
            revision,
            signals: {
                nameMention: trigger.mentionedByName,
                conversationActive: trigger.activeConversation,
                quotedBot: normalized.quotedBot === true,
            },
            dependencies: cycleDependencies,
        };
        let state = judgeAdmissionStates.get(conversationKey);
        if (state) {
            const previousRevision = state.latest.revision;
            const wasWaiting = state.phase === "waiting-turn";
            const mustInvalidateExpiredRecheck = state.recheckInFlight;
            if (state.timer) turnWaitScheduler.clearTimeout(state.timer);
            state.timer = undefined;
            state.latest = candidate;
            if (wasWaiting || mustInvalidateExpiredRecheck) state.generation++;
            state.phase = "judging";
            if (mustInvalidateExpiredRecheck) state.recheckInFlight = false;
            if (wasWaiting) {
                logger.debug(`[Front] turn wait superseded conversation=${shortId(conversationKey)} revision=${previousRevision}->${revision}`);
            }
            if (state.judgeInFlight) return;
        } else {
            state = {
                key: conversationKey,
                latest: candidate,
                phase: "judging",
                generation: 1,
                judgeInFlight: false,
                recheckInFlight: false,
            };
            judgeAdmissionStates.set(conversationKey, state);
        }
        await runJudge(state, false);
    });
    return dispose;
}
