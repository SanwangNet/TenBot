import type { FrontMode, WakeReason } from "./wake-level.js";

export interface FrontSignals {
    isPrivateMessage: boolean;
    hardMention: boolean;
    nameMention: boolean;
    conversationActive: boolean;
    quotedBot: boolean;
}

export type FrontPolicyDecision =
    | { kind: "admit"; wakeLevel: "hard" | "soft"; reason: WakeReason; admission: WakeReason }
    | { kind: "pass" }
    | { kind: "judge" };

/** Selects the source of WakeLevel while keeping the shared WakeLevel semantics intact. */
export function decideFrontPolicy(mode: FrontMode, signals: FrontSignals): FrontPolicyDecision {
    if (signals.isPrivateMessage) {
        return { kind: "admit", wakeLevel: "hard", reason: "private-message", admission: "private-message" };
    }
    if (signals.hardMention) {
        return { kind: "admit", wakeLevel: "hard", reason: "hard-mention", admission: "hard-mention" };
    }
    if (mode === "judge") return { kind: "judge" };
    if (signals.quotedBot) {
        return { kind: "admit", wakeLevel: "soft", reason: "quoted-bot", admission: "quoted-bot" };
    }
    if (signals.nameMention) {
        return { kind: "admit", wakeLevel: "soft", reason: "name-soft", admission: "name-soft" };
    }
    if (signals.conversationActive) {
        return { kind: "admit", wakeLevel: "soft", reason: "active-soft", admission: "active-soft" };
    }
    return { kind: "pass" };
}
