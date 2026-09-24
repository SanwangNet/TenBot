const ACTIVE_TIMEOUT_MS =
    5 * 60 * 1000;

import type { NormalizedQqMessage } from "../message/normalize-message.js";
import { logger } from "../../shared/logger.js";

interface EngagementState {
    expiresAt: number;
    generation: number;
}

let nextGeneration = 0;

const activeGroups =
    new Map<
        string,
        EngagementState
    >();

function getGroupKey(
    message: NormalizedQqMessage,
): string | null {
    return message.groupId
        ? `group:${message.groupId}`
        : null;
}

export function markConversationActive(
    message: NormalizedQqMessage,
): void {
    const key =
        getGroupKey(message);

    if (!key) {
        return;
    }

    activeGroups.set(key, {
        expiresAt:
            Date.now() +
            ACTIVE_TIMEOUT_MS,
        generation: ++nextGeneration,
    });

    logger.info("[Engagement] active");
}

export function isConversationActive(
    message: NormalizedQqMessage,
): boolean {
    const key =
        getGroupKey(message);

    if (!key) {
        return false;
    }

    const state =
        activeGroups.get(key);

    if (!state) {
        return false;
    }

    if (
        Date.now() >
        state.expiresAt
    ) {
        activeGroups.delete(key);

        logger.info("[Engagement] timeout");

        return false;
    }

    return true;
}

export function stopConversation(
    message: NormalizedQqMessage,
    expectedGeneration?: number,
): void {
    const key =
        getGroupKey(message);

    if (!key) {
        return;
    }

    if (expectedGeneration !== undefined && activeGroups.get(key)?.generation !== expectedGeneration) return;
    activeGroups.delete(key);

    logger.info("[Engagement] exit");
}

export function getConversationGeneration(message: NormalizedQqMessage): number | undefined {
    const key = getGroupKey(message);
    return key && isConversationActive(message) ? activeGroups.get(key)?.generation : undefined;
}
