import type { MemberBotState, MemberRepository } from "./repository.js";
import { logger, shortId } from "../shared/logger.js";

export const BOT_DETECTOR_MAX_TEXT_CODEPOINTS = 10;
export const BOT_DETECTOR_BURST_WINDOW_MS = 3_000;
export const BOT_DETECTOR_COOLDOWN_MS = 20_000;
export const BOT_DETECTOR_AUTO_THRESHOLD = 5;

export interface BotDetectorInput {
    groupOpenid: string;
    memberOpenid: string;
    text: string;
    eligibleText: boolean;
    platformBot: boolean;
}

export interface BotDetectorResult {
    state: MemberBotState;
    markAdded: boolean;
}

interface BurstWindow {
    lastEligibleMessageAt?: number;
    cooldownUntil: number;
}

/** Counts only short, close-together group text bursts; durable bot marks live in the repository. */
export class BotDetector {
    private readonly windows = new Map<string, BurstWindow>();

    constructor(
        private readonly repository: MemberRepository,
        private readonly now: () => number = Date.now,
        private readonly onStateChanged: () => void = () => undefined,
    ) {}

    async observe(input: BotDetectorInput): Promise<BotDetectorResult> {
        const key = `${input.groupOpenid}\u0000${input.memberOpenid}`;
        let state = await this.repository.getMemberBotState(input.groupOpenid, input.memberOpenid);
        if (input.platformBot || state.platformBot || state.manualBot || state.autoBot) {
            this.windows.delete(key);
            return { state, markAdded: false };
        }

        const knownMember = await this.repository.findByOpenid(input.groupOpenid, input.memberOpenid);
        if (!knownMember) {
            this.windows.delete(key);
            return { state, markAdded: false };
        }

        const text = input.text.trim();
        const codepoints = Array.from(text).length;
        const eligible = input.eligibleText && codepoints > 0 && codepoints <= BOT_DETECTOR_MAX_TEXT_CODEPOINTS;
        let window = this.windows.get(key);
        if (!window) {
            window = { cooldownUntil: 0 };
            this.windows.set(key, window);
        }
        const now = this.now();
        if (!eligible) {
            window.lastEligibleMessageAt = undefined;
            return { state, markAdded: false };
        }

        if (window.cooldownUntil > 0) {
            if (now < window.cooldownUntil) {
                window.lastEligibleMessageAt = now;
                return { state, markAdded: false };
            }
            // The first message after cooldown is a fresh baseline, not a burst with a cooldown message.
            window.cooldownUntil = 0;
            window.lastEligibleMessageAt = now;
            return { state, markAdded: false };
        }

        const previousAt = window.lastEligibleMessageAt;
        window.lastEligibleMessageAt = now;
        if (previousAt === undefined || now < previousAt || now - previousAt > BOT_DETECTOR_BURST_WINDOW_MS) {
            return { state, markAdded: false };
        }

        window.cooldownUntil = now + BOT_DETECTOR_COOLDOWN_MS;
        state = await this.repository.incrementDetectionMark(
            input.groupOpenid,
            input.memberOpenid,
            now,
            BOT_DETECTOR_AUTO_THRESHOLD,
        );
        try { this.onStateChanged(); } catch { /* The management UI is an observer only. */ }
        if (state.autoBot) {
            logger.info(`[BotDetector] auto bot detected group=${shortId(input.groupOpenid)} member=${shortId(input.memberOpenid)} marks=${state.detectionMarks}`);
        } else {
            logger.info(`[BotDetector] mark group=${shortId(input.groupOpenid)} member=${shortId(input.memberOpenid)} marks=${state.detectionMarks}`);
        }
        return { state, markAdded: true };
    }

    clearGroup(groupOpenid: string): void {
        for (const key of this.windows.keys()) {
            if (key.startsWith(`${groupOpenid}\u0000`)) this.windows.delete(key);
        }
    }
}
