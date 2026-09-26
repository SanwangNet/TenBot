export type WakeLevel = "pass" | "soft" | "hard";
export type WakeReason = "hard-mention" | "name-soft" | "active-soft" | "quoted-bot" | "reply-judge";
export type WakeAdmission = "hard-mention" | "reply-judge";

export function wakeLevelRank(level: WakeLevel): number {
    return level === "hard" ? 2 : level === "soft" ? 1 : 0;
}
