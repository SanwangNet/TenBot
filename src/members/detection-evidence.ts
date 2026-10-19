export const MEMBER_BOT_DETECTION_EVIDENCE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Keep message IDs long enough to suppress delayed QQ redelivery across restarts. */
export const MEMBER_BOT_DETECTION_OBSERVATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface MemberBotDetectionEvidence {
    id: number;
    groupOpenid: string;
    memberOpenid: string;
    signalType: string;
    createdAt: number;
    expiresAt: number;
}

export interface AddMemberBotDetectionEvidence {
    groupOpenid: string;
    memberOpenid: string;
    signalType: string;
    createdAt?: number;
    expiresAt?: number;
}

export interface MemberBotDetectionObservation {
    groupOpenid: string;
    memberOpenid: string;
    messageId: string;
    normalizedText: string;
    observedAt: number;
    expiresAt: number;
}
