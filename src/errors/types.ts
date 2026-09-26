export type ErrorZone = "F" | "M" | "B" | "R";
export type ErrorClass = "A" | "B" | "C";

export interface ParsedErrorCode {
    zone: ErrorZone;
    class: ErrorClass;
    stage: string;
    reason: string;
}

/** Only low-risk diagnostic fields are accepted; raw request data is not metadata. */
export interface TenBotSafeDetails {
    provider?: string;
    attempt?: number;
    httpStatus?: number;
    sent?: number;
    stageOrder?: number;
}

export interface TenBotErrorOptions {
    cause?: unknown;
    safeDetails?: TenBotSafeDetails;
}
