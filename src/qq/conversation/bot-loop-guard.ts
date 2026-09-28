import "dotenv/config";

import {
    DEFAULT_BOT_LOOP_GUARD_MAX_CYCLES,
    parseBotLoopGuardMaxCycles,
} from "../../config/config-validation.js";
import { logger, truncateLogText } from "../../shared/logger.js";

export { DEFAULT_BOT_LOOP_GUARD_MAX_CYCLES, parseBotLoopGuardMaxCycles } from "../../config/config-validation.js";
export const BOT_LOOP_GUARD_STATE_TTL_MS = 30 * 60 * 1000;
export const BOT_LOOP_GUARD_NOTICE = "机器人账号连续互聊已达到限制，等待真人消息。";

export interface BotLoopGuardDecision {
    botMessage: boolean;
    allowed: boolean;
    cycle?: number;
    maxCycles?: number;
    sendNotice?: boolean;
}

export interface BotLoopGuard {
    setMaxCycles(maxCycles: number): void;
    observeBotMessage(conversationKey: string): void;
    resetByHumanMessage(conversationKey: string, authorName?: string): void;
    beforeNewCycle(conversationKey: string, botMessage: boolean, authorName?: string): BotLoopGuardDecision;
}

interface ConversationGuardState {
    botDrivenCycles: number;
    locked: boolean;
    noticeSent: boolean;
    updatedAt: number;
}

function authorLabel(authorName?: string): string {
    return JSON.stringify(truncateLogText(authorName?.trim() || "未知成员", 60));
}

export function createBotLoopGuard(
    initialMaxCycles = DEFAULT_BOT_LOOP_GUARD_MAX_CYCLES,
    now: () => number = Date.now,
    stateTtlMs = BOT_LOOP_GUARD_STATE_TTL_MS,
): BotLoopGuard {
    if (!Number.isSafeInteger(initialMaxCycles) || initialMaxCycles < 1) {
        throw new Error("BOT_LOOP_GUARD_MAX_CYCLES 必须是大于等于 1 的整数");
    }
    let maxCycles = initialMaxCycles;
    const states = new Map<string, ConversationGuardState>();

    function expireInactiveStates(currentTime: number): void {
        for (const [key, state] of states) {
            if (currentTime - state.updatedAt >= stateTtlMs) states.delete(key);
        }
    }

    return {
        setMaxCycles(nextMaxCycles) {
            if (!Number.isSafeInteger(nextMaxCycles) || nextMaxCycles < 1) {
                throw new Error("BOT_LOOP_GUARD_MAX_CYCLES 必须是大于等于 1 的整数");
            }
            maxCycles = nextMaxCycles;
        },
        observeBotMessage(conversationKey) {
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
        beforeNewCycle(conversationKey, botMessage, authorName) {
            if (!botMessage) return { botMessage: false, allowed: true };
            const currentTime = now();
            expireInactiveStates(currentTime);
            let state = states.get(conversationKey);
            if (!state) {
                state = { botDrivenCycles: 0, locked: false, noticeSent: false, updatedAt: currentTime };
                states.set(conversationKey, state);
            }
            state.updatedAt = currentTime;
            if (state.locked || state.botDrivenCycles >= maxCycles) {
                const firstBlock = !state.locked;
                state.locked = true;
                const sendNotice = !state.noticeSent;
                state.noticeSent = true;
                if (firstBlock) {
                    logger.info(`[BotLoop] limit reached cycles=${state.botDrivenCycles} author=${authorLabel(authorName)}`);
                } else {
                    logger.debug(`[BotLoop] blocked author=${authorLabel(authorName)}`);
                }
                return {
                    botMessage: true,
                    allowed: false,
                    cycle: state.botDrivenCycles,
                    maxCycles,
                    sendNotice,
                };
            }
            state.botDrivenCycles++;
            logger.info(`[BotLoop] bot cycle=${state.botDrivenCycles}/${maxCycles} author=${authorLabel(authorName)}`);
            return {
                botMessage: true,
                allowed: true,
                cycle: state.botDrivenCycles,
                maxCycles,
            };
        },
    };
}

export const BOT_LOOP_GUARD_MAX_CYCLES = parseBotLoopGuardMaxCycles(process.env.BOT_LOOP_GUARD_MAX_CYCLES);
export const botLoopGuard = createBotLoopGuard(BOT_LOOP_GUARD_MAX_CYCLES);
