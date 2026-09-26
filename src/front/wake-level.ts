export type WakeLevel = "pass" | "soft" | "hard";
export type FrontMode = "legacy" | "judge";
export type WakeReason = "hard-mention" | "private-message" | "name-soft" | "active-soft" | "quoted-bot" | "reply-judge";
export type WakeAdmission = "hard-mention" | "private-message" | "name-soft" | "active-soft" | "quoted-bot" | "reply-judge";

export function wakeLevelRank(level: WakeLevel): number {
    return level === "hard" ? 2 : level === "soft" ? 1 : 0;
}
