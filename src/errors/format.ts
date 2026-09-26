import { ERROR_CATALOG, ERROR_STAGE_CATALOG, isTenBotErrorCode } from "./catalog.js";
import type { ParsedErrorCode } from "./types.js";
import { TenBotError } from "./tenbot-error.js";

const ERROR_CODE_PATTERN = /^([FMBR]):([ABC])_([A-Z0-9]{2,4})_([A-Z0-9]{2,8})$/;

export function parseErrorCode(code: string): ParsedErrorCode | null {
    const match = ERROR_CODE_PATTERN.exec(code);
    if (!match || !isTenBotErrorCode(code)) return null;
    const [, zone, errorClass, stage, reason] = match;
    if (!Object.hasOwn(ERROR_STAGE_CATALOG[zone as keyof typeof ERROR_STAGE_CATALOG], stage)) return null;
    return { zone: zone as ParsedErrorCode["zone"], class: errorClass as ParsedErrorCode["class"], stage, reason };
}

function formatSafeDetails(error: TenBotError): string {
    const details = error.safeDetails;
    if (!details) return "";
    const fields = Object.entries(details).filter(([, value]) => value !== undefined);
    return fields.length ? " " + fields.map(([key, value]) => `${key}=${String(value)}`).join(" ") : "";
}

export function formatTenBotError(error: TenBotError): string {
    const metadata = ERROR_CATALOG[error.code];
    return `[ERROR] ${error.code} ${metadata.english} / ${metadata.chinese}${formatSafeDetails(error)}`;
}

export function toPublicErrorMessage(error: TenBotError): string {
    return `ERROR: ${error.code}`;
}
