export interface MemeResearch {
    memes: unknown[];
}

export class MemeResponseError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "MemeResponseError";
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeToken(value: unknown): string {
    return typeof value === "string" && /^[a-z_]{1,32}$/.test(value) ? value : "unknown";
}

/** Accept a normal Responses object or one JSON-encoded Response string. */
export function normalizeResponsesResponse(value: unknown): Record<string, unknown> {
    if (typeof value === "string") {
        try {
            value = JSON.parse(value.trim());
        } catch {
            throw new MemeResponseError("invalid Responses payload: JSON parse failed");
        }
    }
    if (!isRecord(value)) {
        throw new MemeResponseError(`invalid Responses payload: expected object, got ${value === null ? "null" : typeof value}`);
    }
    return value;
}

function parseStructuredPayload(value: unknown): MemeResearch {
    if (typeof value === "string") {
        try {
            value = JSON.parse(value);
        } catch {
            throw new MemeResponseError("structured output JSON parse failed");
        }
    }
    if (!isRecord(value) || !Array.isArray(value.memes)) {
        throw new MemeResponseError("invalid MemeResearch: memes must be an array");
    }
    return { memes: value.memes };
}

function finalAssistantText(output: unknown[]): unknown {
    for (let index = output.length - 1; index >= 0; index--) {
        const item = output[index];
        if (!isRecord(item) || item.type !== "message" || item.role !== "assistant") continue;
        if (!Array.isArray(item.content)) break;
        for (let contentIndex = item.content.length - 1; contentIndex >= 0; contentIndex--) {
            const content = item.content[contentIndex];
            if (isRecord(content) && content.type === "output_text" &&
                ((typeof content.text === "string" && content.text.trim()) || isRecord(content.text))) {
                return content.text;
            }
        }
        break;
    }
    throw new MemeResponseError("completed Responses payload has no final assistant output_text");
}

export function parseMemeResearchResponse(value: unknown): MemeResearch {
    const response = normalizeResponsesResponse(value);
    if (response.status !== "completed") {
        throw new MemeResponseError(`Research response status: ${safeToken(response.status)}`);
    }
    if (!Array.isArray(response.output)) {
        throw new MemeResponseError("invalid Responses payload: output must be an array");
    }
    if (!response.output.some((item) => isRecord(item) && item.type === "web_search_call")) {
        throw new MemeResponseError("Research response did not use web_search; knowledge file unchanged");
    }
    const structured = typeof response.output_text === "string" && response.output_text.trim()
        ? response.output_text
        : isRecord(response.output_text)
          ? response.output_text
          : finalAssistantText(response.output);
    return parseStructuredPayload(structured);
}

/** Metadata only; never includes text, queries, or encrypted reasoning. */
export function responseDiagnostics(value: unknown): string {
    const response = normalizeResponsesResponse(value);
    const types = Array.isArray(response.output)
        ? response.output.slice(0, 20).map((item) => isRecord(item) ? safeToken(item.type) : "unknown")
        : [];
    let textLength = typeof response.output_text === "string" ? response.output_text.length : 0;
    if (!textLength && Array.isArray(response.output)) {
        try {
            const text = finalAssistantText(response.output);
            if (typeof text === "string") textLength = text.length;
        } catch { /* diagnostics must never mask the parser error */ }
    }
    return `status=${safeToken(response.status)} output=[${types.join(",")}] output_text_chars=${textLength}`;
}
