import "dotenv/config";

import {
    DEFAULT_BOT_LOOP_GUARD_MAX_CYCLES,
    parseAutomatedPeerIds,
    parseBotLoopGuardMaxCycles,
} from "../../config/config-validation.js";
import { logger, truncateLogText } from "../../shared/logger.js";

export { DEFAULT_BOT_LOOP_GUARD_MAX_CYCLES, parseAutomatedPeerIds, parseBotLoopGuardMaxCycles } from "../../config/config-validation.js";
export const BOT_LOOP_GUARD_STATE_TTL_MS = 30 * 60 * 1000;
export const BOT_LOOP_GUARD_NOTICE = "已达到自动账号连续交互限制，等待真人消息。";

export interface BotLoopGuardDecision {
    automatedPeer: boolean;
    allowed: boolean;
    cycle?: number;
    maxCycles?: number;
    sendNotice?: boolean;
}

export interface AutomatedPeerLoopGuard {
    isAutomatedPeer(authorId: string | undefined): boolean;
    observeAutomatedPeerMessage(conversationKey: string): void;
    resetByHumanMessage(conversationKey: string, authorName?: string): void;
    beforeNewCycle(conversationKey: string, authorId: string | undefined, authorName?: string): BotLoopGuardDecision;
}

interface ConversationGuardState {
    automatedPeerDrivenCycles: number;
    locked: boolean;
    noticeSent: boolean;
    updatedAt: number;
}

function authorLabel(authorName?: string): string {
    return JSON.stringify(truncateLogText(authorName?.trim() || "未知成员", 60));
}

export function createAutomatedPeerLoopGuard(
    peerIds: string | Iterable<string> | undefined,
    maxCycles = DEFAULT_BOT_LOOP_GUARD_MAX_CYCLES,
    now: () => number = Date.now,
    stateTtlMs = BOT_LOOP_GUARD_STATE_TTL_MS,
): AutomatedPeerLoopGuard {
    if (!Number.isSafeInteger(maxCycles) || maxCycles < 1) {
        throw new Error("BOT_LOOP_GUARD_MAX_CYCLES 必须是大于等于 1 的整数");
    }
    const ids = typeof peerIds === "string" || peerIds === undefined
        ? new Set(parseAutomatedPeerIds(peerIds))
        : new Set([...peerIds].map((id) => id.trim()).filter(Boolean));
    const states = new Map<string, ConversationGuardState>();

    function expireInactiveStates(currentTime: number): void {
        for (const [key, state] of states) {
            if (currentTime - state.updatedAt >= stateTtlMs) states.delete(key);
        }
    }

    return {
        isAutomatedPeer(authorId) {
            return typeof authorId === "string" && authorId.length > 0 && ids.has(authorId);
        },
        observeAutomatedPeerMessage(conversationKey) {
            const currentTime = now();
            expireInactiveStates(currentTime);
            const state = states.get(conversationKey);
            if (state) state.updatedAt = currentTime;
        },
        resetByHumanMessage(conversationKey, authorName) {
            const currentTime = now();
            expireInactiveStates(currentTime);
            const state = states.get(conversationKey);
            if (!state) return;
            states.delete(conversationKey);
            logger.info(`[BotLoop] reset by human author=${authorLabel(authorName)}`);
        },
        beforeNewCycle(conversationKey, authorId, authorName) {
            if (typeof authorId !== "string" || !authorId || !ids.has(authorId)) {
                return { automatedPeer: false, allowed: true };
            }
            const currentTime = now();
            expireInactiveStates(currentTime);
            let state = states.get(conversationKey);
            if (!state) {
                state = { automatedPeerDrivenCycles: 0, locked: false, noticeSent: false, updatedAt: currentTime };
                states.set(conversationKey, state);
            }
            state.updatedAt = currentTime;
            if (state.locked || state.automatedPeerDrivenCycles >= maxCycles) {
                const firstBlock = !state.locked;
                state.locked = true;
                const sendNotice = !state.noticeSent;
                state.noticeSent = true;
                if (firstBlock) {
                    logger.info(`[BotLoop] limit reached cycles=${state.automatedPeerDrivenCycles} author=${authorLabel(authorName)}`);
                } else {
                    logger.debug(`[BotLoop] blocked author=${authorLabel(authorName)}`);
                }
                return {
                    automatedPeer: true,
                    allowed: false,
                    cycle: state.automatedPeerDrivenCycles,
                    maxCycles,
                    sendNotice,
                };
            }
            state.automatedPeerDrivenCycles++;
            logger.info(`[BotLoop] automated cycle=${state.automatedPeerDrivenCycles}/${maxCycles} author=${authorLabel(authorName)}`);
            return {
                automatedPeer: true,
                allowed: true,
                cycle: state.automatedPeerDrivenCycles,
                maxCycles,
            };
        },
    };
}

export const BOT_LOOP_GUARD_MAX_CYCLES = parseBotLoopGuardMaxCycles(process.env.BOT_LOOP_GUARD_MAX_CYCLES);
export const automatedPeerLoopGuard = createAutomatedPeerLoopGuard(
    process.env.AUTOMATED_PEER_IDS,
    BOT_LOOP_GUARD_MAX_CYCLES,
);

export function isAutomatedPeer(authorId: string | undefined): boolean {
    return automatedPeerLoopGuard.isAutomatedPeer(authorId);
}
