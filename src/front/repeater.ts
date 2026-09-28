export interface RepeaterInput {
    groupId: string;
    senderId: string;
    content: string;
}

export type RepeaterDecision =
    | { repeat: true; content: string }
    | { repeat: false };

interface GroupRepeaterState {
    lastEligibleSenderId: string;
    lastEligibleContent: string;
    activeRepeatContent?: string;
}

/** Tracks only the latest eligible human text and the currently echoed phrase per group. */
export class GroupRepeater {
    private readonly groups = new Map<string, GroupRepeaterState>();

    observe(input: RepeaterInput): RepeaterDecision {
        const content = input.content.replace(/\r\n/g, "\n");
        if (!input.groupId || !input.senderId || !content) return { repeat: false };

        const state = this.groups.get(input.groupId);
        if (!state) {
            this.groups.set(input.groupId, {
                lastEligibleSenderId: input.senderId,
                lastEligibleContent: content,
            });
            return { repeat: false };
        }

        if (state.activeRepeatContent !== undefined) {
            if (content === state.activeRepeatContent) {
                state.lastEligibleSenderId = input.senderId;
                state.lastEligibleContent = content;
                return { repeat: false };
            }
            state.activeRepeatContent = undefined;
        }

        const shouldRepeat = content === state.lastEligibleContent &&
            input.senderId !== state.lastEligibleSenderId;
        state.lastEligibleSenderId = input.senderId;
        state.lastEligibleContent = content;
        if (!shouldRepeat) return { repeat: false };

        state.activeRepeatContent = content;
        return { repeat: true, content };
    }
}
