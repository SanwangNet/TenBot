import type { Logger as QqSdkLogger } from "@tencent-connect/qqbot-nodejs";
import { resolve } from "node:path";
import { formatTenBotError } from "../errors/format.js";
import { isTenBotError } from "../errors/tenbot-error.js";
import { LogFileSink } from "./log-file-sink.js";

export type LogLevel = "all" | "debug" | "info" | "warn" | "error";

export interface LogEntry {
    timestamp: string;
    level: LogLevel;
    text: string;
    /** Stable identity and canonical repeat metadata are assigned by LogBuffer. */
    rowId?: string;
    repeatCount?: number;
    firstTimestamp?: string;
}

export type LogListener = (entry: LogEntry) => void;

const levels: Record<LogLevel, number> = { all: 0, debug: 1, info: 2, warn: 3, error: 4 };
const logListeners = new Set<LogListener>();
let consoleOutputEnabled = true;
let logFileSink: LogFileSink | undefined;
let environmentSecrets: string[] = [];

export function parseLogLevel(value: string | undefined): LogLevel {
    const normalized = value?.trim().toLowerCase();
    return normalized && Object.hasOwn(levels, normalized) ? normalized as LogLevel : "info";
}

export function refreshLogRedactionSecrets(additionalSecrets: readonly (string | undefined)[] = []): void {
    environmentSecrets = [...Object.entries(process.env)
        .filter(([name, secret]) => Boolean(secret) && /(?:KEY|APP_SECRET|ACCESS_TOKEN|REFRESH_TOKEN|TOKEN|PASSWORD|CREDENTIAL|AUTHORIZATION|COOKIE|SECRET)$/i.test(name))
        .map(([, secret]) => secret!)
        .filter((secret) => secret.length > 0), ...additionalSecrets.filter((secret): secret is string => Boolean(secret))];
}

refreshLogRedactionSecrets();

const configuredConsoleLogLevel = process.env.BOT_LOG_LEVEL;
const consoleLogLevel = parseLogLevel(configuredConsoleLogLevel);
if (configuredConsoleLogLevel?.trim() && parseLogLevel(configuredConsoleLogLevel) === "info" && configuredConsoleLogLevel.trim().toLowerCase() !== "info") {
    const safeValue = sanitizeSecrets(configuredConsoleLogLevel).replace(/[\r\n\u0000-\u001f\u007f]/g, " ").slice(0, 80);
    console.warn(`[Logging] invalid BOT_LOG_LEVEL="${safeValue}"; falling back to info`);
}

function timestamp(): string {
    return new Date().toLocaleTimeString("en-GB", { hour12: false });
}

const secretKeyPattern = /(?:auth.?token|access.?token|refresh.?token|app.?secret|client.?secret|api.?key|authorization|set.?cookie|cookie|password|credential|session.?key|private.?key|signature|^sig$|^sign$|^key$|^auth$|^secret$|^token$)/i;
const safeOpenIdPattern = /\b(?:member|group|user)?[_-]?openid\b(\s*[=:]\s*)([^\s,}&"']+)/gi;

/** Redact credentials while retaining diagnostic IDs, OpenIDs, URLs, and payload structure. */
export function sanitizeSecrets(value: string): string {
    let safe = value
        .replace(/\bAuthorization\s*:\s*[^\r\n]+/gi, "Authorization: [REDACTED]")
        .replace(/\b(?:Set-)?Cookie\s*:\s*[^\r\n]+/gi, "Cookie: [REDACTED]")
        .replace(/\b(Bearer|QQBot)\s+[A-Za-z0-9._~+\/-]+=*/gi, "$1 [REDACTED]")
        .replace(/(["']?(?:auth[_-]?token|access[_-]?token|refresh[_-]?token|app[_-]?secret|client[_-]?secret|api[_-]?key|authorization|cookie|password|credential|session[_-]?key|private[_-]?key|token)["']?\s*[=:]\s*["']?)([^\s,}&"']+)/gi, "$1[REDACTED]")
        .replace(/([?&](?:api[_-]?key|key|access[_-]?token|refresh[_-]?token|token|signature|sig|sign|credential|auth|secret|hm|ex)=)[^&#\s]+/gi, "$1[REDACTED]");

    // Also redact credentials supplied under deployment-specific environment names.
    for (const secret of environmentSecrets) {
        safe = safe.replaceAll(secret, "[REDACTED]");
    }
    return safe;
}

/** Redact credentials and apply the long-standing low-noise masking used by info/debug/error. */
export function sanitizeSafeDiagnostic(value: string): string {
    return sanitizeSecrets(value)
        .replace(safeOpenIdPattern, (_match, separator: string) => `openid${separator}[ID]`)
        .replace(/https?:\/\/[^\s"'<>?]+\?[^\s"'<>]*/gi, "[URL query redacted]")
        .replace(/\/(groups|users|members|files)\/[A-Za-z0-9_-]{6,}/gi, "/$1/[ID]")
        .replace(/\b[A-Za-z0-9_-]{24,}\b/g, (id) => `${id.slice(0, 6)}…`);
}

function sanitizeObject(value: unknown, includeBusinessIdentifiers: boolean, seen = new WeakSet<object>()): unknown {
    if (value instanceof Date) return value.toISOString();
    if (value instanceof URL) return value.toString();
    if (value && typeof value === "object") {
        if (seen.has(value)) return "[Circular]";
        seen.add(value);
    }
    if (Array.isArray(value)) {
        const safeArray = value.map((item) => sanitizeObject(item, includeBusinessIdentifiers, seen));
        seen.delete(value);
        return safeArray;
    }
    if (value && typeof value === "object") {
        const object = value instanceof Error
            ? {
                name: value.name,
                message: value.message,
                stack: value.stack,
                ...Object.fromEntries(Object.entries(value)),
                ...(value.cause === undefined ? {} : { cause: value.cause }),
            }
            : value;
        const safe: Record<string, unknown> = {};
        for (const [key, nestedValue] of Object.entries(object)) {
            if (secretKeyPattern.test(key)) safe[key] = "[REDACTED]";
            else if (!includeBusinessIdentifiers && /openid/i.test(key)) safe[key] = "[ID]";
            else safe[key] = sanitizeObject(nestedValue, includeBusinessIdentifiers, seen);
        }
        seen.delete(value);
        return safe;
    }
    return value;
}

function formatValue(value: unknown, includeBusinessIdentifiers: boolean): string {
    if (typeof value === "string") {
        return includeBusinessIdentifiers ? sanitizeSecrets(value) : sanitizeSafeDiagnostic(value);
    }
    if (value === undefined) return "undefined";
    try {
        const safeValue = sanitizeObject(value, includeBusinessIdentifiers);
        const serialized = JSON.stringify(safeValue);
        return includeBusinessIdentifiers ? sanitizeSecrets(serialized) : sanitizeSafeDiagnostic(serialized);
    } catch {
        const fallback = String(value);
        return includeBusinessIdentifiers ? sanitizeSecrets(fallback) : sanitizeSafeDiagnostic(fallback);
    }
}

function formatValues(level: LogLevel, values: unknown[], includeBusinessIdentifiers: boolean, preserveLastString = false): string {
    const presentValues = values.filter((value) => value !== undefined);
    const formalError = level === "error" ? presentValues.find(isTenBotError) : undefined;
    return formalError
        ? includeBusinessIdentifiers
            ? sanitizeSecrets(formatTenBotError(formalError))
            : sanitizeSafeDiagnostic(formatTenBotError(formalError))
        : presentValues.map((value, index) => {
            if (preserveLastString && index === presentValues.length - 1 && typeof value === "string") {
                return sanitizeSecrets(value);
            }
            return formatValue(value, includeBusinessIdentifiers);
        }).join(" ");
}

function write(level: LogLevel, values: unknown[], preserveLastString = false): void {
    const rawText = formatValues(level, values, true, preserveLastString);
    const safeText = formatValues(level, values, false, preserveLastString);
    const formalError = level === "error" ? values.find(isTenBotError) : undefined;
    const timestampValue = new Date().toISOString();
    logFileSink?.write({ timestamp: timestampValue, level, text: safeText }, rawText);

    const text = level === "all" ? rawText : safeText;
    const entry: LogEntry = { timestamp: timestampValue, level, text };

    for (const listener of logListeners) {
        try { listener(entry); } catch { /* A log consumer must not break Runtime work. */ }
    }
    if (!consoleOutputEnabled || !shouldWriteToConsole(level)) return;
    const lines = text.split("\n");
    const output = lines.map((line, index) => index === 0 && !formalError ? `[${timestamp()}] ${line}` : line).join("\n");
    if (level === "error") console.error(output);
    else if (level === "warn") console.warn(output);
    else console.log(output);
}

function shouldWriteToConsole(level: LogLevel): boolean {
    return level === "all"
        ? consoleLogLevel === "all"
        : levels[level] >= levels[consoleLogLevel];
}

export const logger = {
    all: (...values: unknown[]) => write("all", values),
    info: (...values: unknown[]) => write("info", values),
    debug: (...values: unknown[]) => write("debug", values),
    warn: (...values: unknown[]) => write("warn", values),
    error: (...values: unknown[]) => write("error", values),
};

export function subscribeLogs(listener: LogListener): () => void {
    logListeners.add(listener);
    return () => logListeners.delete(listener);
}

export function setConsoleLogOutputEnabled(enabled: boolean): void { consoleOutputEnabled = enabled; }

export function configureLogFileSink(directory = resolve(process.cwd(), "logs")): void {
    const previous = logFileSink;
    logFileSink = new LogFileSink(directory, (error) => {
        if (consoleOutputEnabled) console.warn("[Logging] local log file write failed", formatValue(error, true));
    });
    if (previous) void previous.close();
}

export async function flushLogFileSink(): Promise<void> { await logFileSink?.flush(); }

export async function closeLogFileSink(): Promise<void> {
    const sink = logFileSink;
    logFileSink = undefined;
    await sink?.close();
}

export function truncateLogText(value: string, maxLength = 160): string {
    const safe = sanitizeSafeDiagnostic(value).replace(/\s+/g, " ").trim();
    return safe.length > maxLength ? `${safe.slice(0, maxLength)}…` : safe;
}

/** ALL diagnostics retain the full peer ID for explicit registration. */
export function debugPeerIdentity(authorName: string | undefined, stableId: string | undefined): void {
    if (!stableId) return;
    const id = stableId.length <= 256 ? JSON.stringify(stableId) : "[invalid-id]";
    write("all", [`[Peer] author=${JSON.stringify(truncateLogText(authorName || "unknown member", 60))} id=${id}`], true);
}

export function shortId(value: string | undefined, length = 6): string {
    if (!value) return "unknown";
    return value.length > length ? `${value.slice(0, length)}…` : value;
}

/** SDK info/debug diagnostics are captured once as ALL; warnings and errors retain severity. */
export const qqSdkLogger: QqSdkLogger = {
    info(message) {
        logger.all("[QQ SDK] info", message);
    },
    warn(message, meta) {
        logger.warn("[QQ SDK]", message, meta);
    },
    error(message, meta) {
        logger.error("[QQ SDK] error", message, meta);
    },
    debug(message, meta) {
        logger.all("[QQ SDK] raw", message, meta);
    },
};
