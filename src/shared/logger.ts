import type { Logger as QqSdkLogger } from "@tencent-connect/qqbot-nodejs";

export type LogLevel = "info" | "debug" | "error";

const configuredLevel = process.env.BOT_LOG_LEVEL?.toLowerCase();
const logLevel: LogLevel = configuredLevel === "debug" || configuredLevel === "error"
    ? configuredLevel
    : "info";

const levels: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    error: 2,
};

function timestamp(): string {
    return new Date().toLocaleTimeString("en-GB", { hour12: false });
}

function sanitizeText(value: string): string {
    let safe = value
        .replace(
            /\b(auth[_-]?token|access[_-]?token|refresh[_-]?token|app[_-]?secret|client[_-]?secret|api[_-]?key|authorization|cookie|(?:member|group|user)?[_-]?openid|token)\b(\s*[=:]\s*)([^\s,}&"']+)/gi,
            "$1$2[REDACTED]",
        )
        .replace(/\bAuthorization\s*:\s*[^\r\n]+/gi, "Authorization: [REDACTED]")
        .replace(/\b(Bearer|QQBot)\s+[A-Za-z0-9._~+\/-]+=*/gi, "$1 [REDACTED]")
        .replace(
            /("(?:auth[_-]?token|access[_-]?token|refresh[_-]?token|app[_-]?secret|client[_-]?secret|api[_-]?key|authorization|cookie|(?:member|group|user)?[_-]?openid|token)"\s*:\s*")[^"]*(")/gi,
            "$1[REDACTED]$2",
        )
        .replace(/https?:\/\/[^\s"'<>?]+\?[^\s"'<>]*/gi, "[URL query redacted]")
        .replace(/\/(groups|users|members|files)\/[A-Za-z0-9_-]{6,}/gi, "/$1/[ID]")
        .replace(/\b[A-Za-z0-9_-]{24,}\b/g, (id) => `${id.slice(0, 6)}…`);

    for (const secret of [process.env.QQBOT_APP_SECRET, process.env.CODEX_API_KEY, process.env.DEEPSEEK_API_KEY]) {
        if (secret) {
            safe = safe.replaceAll(secret, "[REDACTED]");
        }
    }
    return safe;
}

function formatValue(value: unknown): string {
    if (value instanceof Error) {
        return sanitizeText(value.stack ?? `${value.name}: ${value.message}`);
    }
    if (typeof value === "string") {
        return sanitizeText(value);
    }
    if (value === undefined) {
        return "undefined";
    }
    try {
        return sanitizeText(JSON.stringify(value, (key, nestedValue: unknown) => {
            if (/(?:auth.?token|access.?token|app.?secret|client.?secret|api.?key|authorization|cookie|openid|token)/i.test(key)) {
                return "[REDACTED]";
            }
            return nestedValue;
        }));
    } catch {
        return sanitizeText(String(value));
    }
}

function write(level: LogLevel, values: unknown[]): void {
    if (levels[level] < levels[logLevel]) {
        return;
    }

    const text = values.filter((value) => value !== undefined).map(formatValue).join(" ");
    const lines = text.split("\n");
    const output = lines.map((line, index) =>
        index === 0 ? `[${timestamp()}] ${line}` : line,
    ).join("\n");

    if (level === "error") {
        console.error(output);
    } else {
        console.log(output);
    }
}

export const logger = {
    level: logLevel,
    info: (...values: unknown[]) => write("info", values),
    debug: (...values: unknown[]) => write("debug", values),
    error: (...values: unknown[]) => write("error", values),
};

export function truncateLogText(value: string, maxLength = 160): string {
    const safe = sanitizeText(value).replace(/\s+/g, " ").trim();
    return safe.length > maxLength ? `${safe.slice(0, maxLength)}…` : safe;
}

export function shortId(value: string | undefined, length = 6): string {
    if (!value) {
        return "unknown";
    }
    return value.length > length ? `${value.slice(0, length)}…` : value;
}

function sdkDebugMessage(message: string): string | null {
    const dispatch = message.match(/Dispatch event: t=([^\s]+)/);
    if (dispatch) {
        return `[QQ SDK] event ${dispatch[1]}`;
    }

    if (/\[qqbot:api\].*(?:Body:)/i.test(message)) {
        return null;
    }

    if (/\[qqbot:api\].*Status:/i.test(message)) {
        return `[QQ SDK] ${message.match(/Status: .*/)?.[0] ?? "API response"}`;
    }

    if (/\[qqbot:api\].*(?:>>>|<<<)/i.test(message)) {
        const method = message.match(/>>>\s+(GET|POST|PUT|PATCH|DELETE)\b/i)?.[1];
        return method ? `[QQ SDK] API ${method}` : "[QQ SDK] API request";
    }

    return `[QQ SDK] ${message}`;
}

/** Keep SDK diagnostics useful while never forwarding payloads or bodies. */
export const qqSdkLogger: QqSdkLogger = {
    info(message) {
        // SDK info includes a line for every successful API call; app-level
        // connection and business events are logged separately.
        logger.debug(`[QQ SDK] ${message}`);
    },
    warn(message, meta) {
        logger.info("[QQ SDK] warning", message, meta);
    },
    error(message, meta) {
        logger.error("[QQ SDK] error", message, meta);
    },
    debug(message, meta) {
        const safeMessage = sdkDebugMessage(message);
        if (safeMessage) {
            logger.debug(safeMessage, meta);
        }
    },
};
