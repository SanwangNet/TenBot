import { MEMBER_BOT_DETECTION_OBSERVATION_TTL_MS } from "./detection-evidence.js";
import type { MemberBotState, MemberRepository } from "./repository.js";

export const BOT_DETECTOR_REPEAT_WINDOW_MS = 10 * 60 * 1000;
export const BOT_DETECTOR_REPEAT_REQUIRED_COUNT = 3;
export const BOT_DETECTOR_MIN_TEXT_CODEPOINTS = 12;
export const BOT_DETECTOR_MIN_REPEAT_SPAN_MS = 60 * 1000;
export const BOT_DETECTOR_SIGNAL_COOLDOWN_MS = 30 * 60 * 1000;
export const BOT_DETECTOR_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

export interface BotDetectorInput {
    groupOpenid: string;
    memberOpenid: string;
    text: string;
    eligibleText: boolean;
    platformBot: boolean;
    messageId?: string;
    messageTimestamp?: string | number;
}

export interface BotDetectorResult {
    state: MemberBotState;
    markAdded: boolean;
}

/** Conservative repeated-text observer. Evidence is advisory and never changes formal Bot identity. */
export class BotDetector {
    private readonly memberLocks = new Map<string, Promise<void>>();

    constructor(
        private readonly repository: MemberRepository,
        private readonly now: () => number = Date.now,
        private readonly onStateChanged: () => void = () => undefined,
    ) {}

    async observe(input: BotDetectorInput): Promise<BotDetectorResult> {
        const key = JSON.stringify([input.groupOpenid, input.memberOpenid]);
        return this.withMemberLock(key, async () => {
            const state = await this.repository.getMemberBotState(input.groupOpenid, input.memberOpenid);
            const normalizedText = normalizeSubstantiveText(input.text);
            const codePointCount = Array.from(normalizedText).length;
            if (!input.eligibleText || input.platformBot || state.platformBot || state.manualBot ||
                !input.messageId || !normalizedText || !/[\p{L}\p{N}]/u.test(normalizedText) ||
                codePointCount < BOT_DETECTOR_MIN_TEXT_CODEPOINTS) {
                return { state, markAdded: false };
            }

            const now = this.now();
            const observedAt = parseMessageTimestamp(input.messageTimestamp) ?? now;
            if (!Number.isFinite(observedAt) || observedAt < now - BOT_DETECTOR_REPEAT_WINDOW_MS ||
                observedAt > now + BOT_DETECTOR_MAX_FUTURE_SKEW_MS) {
                return { state, markAdded: false };
            }

            const inserted = await this.repository.recordDetectionObservation({
                groupOpenid: input.groupOpenid,
                memberOpenid: input.memberOpenid,
                messageId: input.messageId,
                normalizedText,
                observedAt,
                expiresAt: now + MEMBER_BOT_DETECTION_OBSERVATION_TTL_MS,
            });
            if (!inserted) return { state, markAdded: false };

            const observations = await this.repository.listRecentDetectionObservations(
                input.groupOpenid,
                input.memberOpenid,
                now - BOT_DETECTOR_REPEAT_WINDOW_MS,
                now + BOT_DETECTOR_MAX_FUTURE_SKEW_MS,
                now,
            );
            const matching = observations.filter((observation) => observation.normalizedText === normalizedText);
            const hasConservativeRepeat = hasRepeatedTextWindow(matching);
            if (!hasConservativeRepeat) return { state, markAdded: false };

            const evidence = await this.repository.addDetectionEvidenceIfCooldownElapsed({
                groupOpenid: input.groupOpenid,
                memberOpenid: input.memberOpenid,
                signalType: "repeated_text",
                createdAt: now,
            }, BOT_DETECTOR_SIGNAL_COOLDOWN_MS);
            if (!evidence) return { state, markAdded: false };
            try { this.onStateChanged(); } catch { /* Management UI updates are observational only. */ }
            return {
                state: await this.repository.getMemberBotState(input.groupOpenid, input.memberOpenid),
                markAdded: true,
            };
        });
    }

    private async withMemberLock<T>(key: string, action: () => Promise<T>): Promise<T> {
        const previous = this.memberLocks.get(key) ?? Promise.resolve();
        let release!: () => void;
        const current = new Promise<void>((resolve) => { release = resolve; });
        this.memberLocks.set(key, current);
        await previous;
        try {
            return await action();
        } finally {
            release();
            if (this.memberLocks.get(key) === current) this.memberLocks.delete(key);
        }
    }
}

export function normalizeSubstantiveText(text: string): string {
    return text.normalize("NFC").replace(/\s+/gu, " ").trim();
}

function parseMessageTimestamp(value: string | number | undefined): number | null {
    if (typeof value === "number") {
        if (!Number.isFinite(value) || value <= 0) return null;
        return value < 100_000_000_000 ? value * 1000 : value;
    }
    if (typeof value !== "string" || !value.trim()) return null;
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric < 100_000_000_000 ? numeric * 1000 : numeric;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function hasRepeatedTextWindow(observations: readonly { observedAt: number }[]): boolean {
    const ordered = [...observations].sort((left, right) => left.observedAt - right.observedAt);
    for (let end = BOT_DETECTOR_REPEAT_REQUIRED_COUNT - 1; end < ordered.length; end++) {
        const start = end - BOT_DETECTOR_REPEAT_REQUIRED_COUNT + 1;
        const span = ordered[end]!.observedAt - ordered[start]!.observedAt;
        if (span >= BOT_DETECTOR_MIN_REPEAT_SPAN_MS && span <= BOT_DETECTOR_REPEAT_WINDOW_MS) return true;
    }
    return false;
}
