export const TOOL_PROTOCOL_LEAK_CODE = "B:A1_TPL" as const;

/** Safe failure marker. It deliberately carries no model output or request data. */
export class ToolProtocolLeakError extends Error {
    readonly code = TOOL_PROTOCOL_LEAK_CODE;

    constructor() {
        super("Tool Protocol Leakage");
        this.name = "ToolProtocolLeakError";
    }
}

export function isToolProtocolLeakError(error: unknown): error is ToolProtocolLeakError {
    return error instanceof ToolProtocolLeakError;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isReplyMessage(value: unknown): boolean {
    if (!isRecord(value) || typeof value.content !== "string" || !isRecord(value.quote)) return false;
    const quote = value.quote;
    return (quote.mode === "auto" && quote.ref === null) ||
        (quote.mode === "none" && quote.ref === null) ||
        (quote.mode === "message" && typeof quote.ref === "string");
}

function isReplyAction(value: unknown): boolean {
    if (!isRecord(value) || !Array.isArray(value.messages) || !Array.isArray(value.mentions)) return false;
    return value.messages.length > 0 && value.messages.every(isReplyMessage) &&
        value.mentions.every((mention) => typeof mention === "string");
}

/** Only whole, structurally recognizable protocol payloads are rejected. */
export function isToolProtocolLeak(output: string): boolean {
    const text = output.trim();
    if (/^<qq_reply>\s*[\s\S]*\s*<\/qq_reply>$/.test(text)) return true;

    if (!text.startsWith("{") && !text.startsWith("[")) return false;
    let parsed: unknown;
    try { parsed = JSON.parse(text) as unknown; }
    catch { return false; }

    if (Array.isArray(parsed)) return parsed.length > 0 && parsed.every(isReplyMessage);
    return isReplyAction(parsed);
}
