const ACTIVE_TIMEOUT_MS =
    5 * 60 * 1000;

import type { NormalizedQqMessage } from "../message/normalize-message.js";

interface EngagementState {
    expiresAt: number;
}

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
    });

    console.log(
        `[Engagement] ${key} 进入活跃对话`,
    );
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

        console.log(
            `[Engagement] ${key} 超时退出`,
        );

        return false;
    }

    return true;
}

export function stopConversation(
    message: NormalizedQqMessage,
): void {
    const key =
        getGroupKey(message);

    if (!key) {
        return;
    }

    activeGroups.delete(key);

    console.log(
        `[Engagement] ${key} AI 判断对话已结束`,
    );
}
