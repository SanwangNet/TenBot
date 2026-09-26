import { ERROR_CATALOG, isTenBotErrorCode, type TenBotErrorCode } from "./catalog.js";
import type { TenBotErrorOptions, TenBotSafeDetails } from "./types.js";

function safeDetails(details: TenBotSafeDetails | undefined): TenBotSafeDetails | undefined {
    if (!details) return undefined;
    const safe: TenBotSafeDetails = {};
    if (typeof details.provider === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(details.provider)) {
        safe.provider = details.provider;
    }
    for (const key of ["attempt", "httpStatus", "sent", "stageOrder"] as const) {
        const value = details[key];
        if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) safe[key] = value;
    }
    return Object.keys(safe).length ? safe : undefined;
}

export class TenBotError extends Error {
    readonly code: TenBotErrorCode;
    readonly cause?: unknown;
    readonly safeDetails?: Readonly<TenBotSafeDetails>;

    constructor(code: TenBotErrorCode, options: TenBotErrorOptions = {}) {
        if (!isTenBotErrorCode(code)) throw new TypeError("Unknown TenBot error code");
        super(ERROR_CATALOG[code].english, options.cause === undefined ? undefined : { cause: options.cause });
        this.name = "TenBotError";
        this.code = code;
        this.cause = options.cause;
        this.safeDetails = safeDetails(options.safeDetails);
    }
}

export function isTenBotError(error: unknown): error is TenBotError {
    return error instanceof TenBotError;
}
