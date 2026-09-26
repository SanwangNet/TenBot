import { isTenBotError } from "../errors/tenbot-error.js";
import { findExplicitHttpStatus, mapConfirmedRemoteHttpError } from "../errors/http-mapping.js";
import type { TenBotErrorCode } from "../errors/catalog.js";

export interface ProviderErrorNotice {
    provider: string;
    model: string;
    tenbotCode: TenBotErrorCode;
    status?: number;
    code?: string;
    retryable?: boolean;
    message: string;
    details?: string;
    timestamp: string;
}

type Fields = Record<string, unknown>;

function asFields(value: unknown): Fields | undefined {
    return value !== null && typeof value === "object" ? value as Fields : undefined;
}

function collectFields(error: unknown): Fields[] {
    const fields: Fields[] = [];
    const seen = new Set<object>();
    const queue: unknown[] = [error];
    while (queue.length && fields.length < 8) {
        const value = queue.shift();
        const item = asFields(value);
        if (!item || seen.has(item)) continue;
        seen.add(item);
        fields.push(item);
        for (const key of ["cause", "error", "body", "response"]) {
            if (item[key] !== undefined) queue.push(item[key]);
        }
    }
    return fields;
}

function sanitize(value: string, maxLength = 240): string {
    let safe = value
        .replace(/\b(?:authorization|cookie|api[_ -]?key|app[_ -]?secret|client[_ -]?secret|access[_ -]?token|refresh[_ -]?token|token|password)\b\s*[:=]\s*(?:bearer\s+)?[^\s,;}]+/gi, "[REDACTED]")
        .replace(/\b(?:bearer|qqbot)\s+[a-z0-9._~+\/-]+=*/gi, "[REDACTED]")
        .replace(/https?:\/\/[^\s"'<>?]+\?[^\s"'<>]*/gi, "[URL query redacted]")
        .replace(/\b(?:sk|key)-[a-z0-9_-]{8,}\b/gi, "[REDACTED]")
        .replace(/\s+/g, " ")
        .trim();
    return safe.length > maxLength ? `${safe.slice(0, maxLength)}…` : safe;
}

function firstString(fields: readonly Fields[], key: string): string | undefined {
    return fields.map((item) => item[key]).find((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function firstNumber(fields: readonly Fields[], key: string): number | undefined {
    return fields.map((item) => item[key]).find((value): value is number => typeof value === "number" && Number.isInteger(value));
}

function firstBoolean(fields: readonly Fields[], key: string): boolean | undefined {
    return fields.map((item) => item[key]).find((value): value is boolean => typeof value === "boolean");
}

function errorMessages(fields: readonly Fields[]): string[] {
    return fields
        .map((item) => item.message)
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .map((value) => sanitize(value));
}

function safeCode(value: string | undefined): string | undefined {
    if (!value) return undefined;
    const code = sanitize(value, 80).replace(/[^a-zA-Z0-9_.:-]/g, "");
    return code || undefined;
}

/** Runtime-only normalization. It deliberately reads messages and known fields, never raw error JSON. */
export function createProviderErrorNotice(provider: string, model: string, error: unknown): ProviderErrorNotice {
    const fields = collectFields(error);
    const status = findExplicitHttpStatus(error) ?? firstNumber(fields, "status");
    const tenbotCode = isTenBotError(error)
        ? error.code
        : mapConfirmedRemoteHttpError("MP", status) ?? "M:A_MG_MRF";
    const code = safeCode(firstString(fields, "code"));
    const retryable = firstBoolean(fields, "retryable") ?? (status !== undefined && [502, 503, 504, 520].includes(status) ? true : undefined);
    const messages = errorMessages(fields);
    const root = asFields(error);
    const cause = asFields(root?.cause);
    const message = sanitize(messages.find((value) => value !== `${provider} provider request failed`) ?? "模型提供商请求失败");
    const stack = typeof cause?.stack === "string"
        ? cause.stack.split("\n").slice(0, 3).map((line) => sanitize(line, 180)).join("\n")
        : undefined;
    const causeMessage = messages.find((value) => value !== message && value !== `${provider} provider request failed`);
    const detailParts = [causeMessage, stack].filter((value, index, all): value is string => Boolean(value) && all.indexOf(value) === index);
    return {
        provider: sanitize(provider, 40),
        model: sanitize(model, 100),
        tenbotCode,
        ...(status !== undefined ? { status } : {}),
        ...(code ? { code } : {}),
        ...(retryable !== undefined ? { retryable } : {}),
        message,
        ...(detailParts.length ? { details: detailParts.join("\n") } : {}),
        timestamp: new Date().toISOString(),
    };
}
