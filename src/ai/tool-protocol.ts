import { TenBotError } from "../errors/tenbot-error.js";

/** Safe failure marker. It deliberately carries no model output or request data. */
export class ToolProtocolLeakError extends TenBotError {
    constructor() {
        super("B:A_OP_TPL");
        this.name = "ToolProtocolLeakError";
    }
}

export function isToolProtocolLeakError(error: unknown): error is ToolProtocolLeakError {
    return error instanceof ToolProtocolLeakError;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isQuotePreference(quote: unknown): boolean {
    if (!isRecord(quote)) return false;
    return (quote.mode === "auto" && quote.ref === null) ||
        (quote.mode === "none" && quote.ref === null) ||
        (quote.mode === "message" && typeof quote.ref === "string");
}

function isReplyMessage(value: unknown): boolean {
    if (!isRecord(value) || typeof value.content !== "string") return false;
    return value.quote === undefined || isQuotePreference(value.quote);
}

function isReplyAction(value: unknown): boolean {
    if (!isRecord(value) || !Array.isArray(value.messages) || !Array.isArray(value.mentions)) return false;
    if (!value.messages.every(isReplyMessage) || !value.mentions.every((mention) => typeof mention === "string")) return false;
    if (value.meme !== undefined && value.meme !== null && typeof value.meme !== "string") return false;

    const hasMemeField = Object.hasOwn(value, "meme");
    const hasLegacyQuote = Object.hasOwn(value, "quote") && (value.quote === null || isQuotePreference(value.quote));
    const hasNestedQuote = value.messages.some((message) => isRecord(message) && isQuotePreference(message.quote));
    const hasMeme = typeof value.meme === "string" && value.meme.trim().length > 0;
    const hasProtocolMarker = hasMemeField || hasLegacyQuote || hasNestedQuote;

    // Empty messages are valid only for a meme-only action. A `messages` field
    // by itself is too generic to classify arbitrary JSON as leaked protocol.
    return hasProtocolMarker && (value.messages.length > 0 || hasMeme);
}

/** Only whole, structurally recognizable protocol payloads are rejected. */
export function isToolProtocolLeak(output: string): boolean {
    const text = output.trim();
    if (/^<qq_reply>\s*[\s\S]*\s*<\/qq_reply>$/.test(text)) return true;

    if (!text.startsWith("{") && !text.startsWith("[")) return false;
    let parsed: unknown;
    try { parsed = JSON.parse(text) as unknown; }
    catch { return false; }

    if (Array.isArray(parsed)) return parsed.length > 0 && parsed.every((message) =>
        isReplyMessage(message) && isRecord(message) && isQuotePreference(message.quote));
    return isReplyAction(parsed);
}
