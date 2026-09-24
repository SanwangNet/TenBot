/** Preserve structured stream failure fields without logging the upstream body. */
export class AiResponseFailure extends Error {
    readonly code: string | undefined;
    readonly status: number | undefined;
    readonly retryable: boolean | undefined;

    constructor(error: unknown) {
        super("Responses stream failed");
        this.name = "AiResponseFailure";
        if (error && typeof error === "object") {
            const fields = error as Record<string, unknown>;
            this.code = typeof fields.code === "string" ? fields.code : undefined;
            this.status = typeof fields.status === "number" ? fields.status : undefined;
            this.retryable = fields.retryable === true ? true : undefined;
        }
    }
}

export interface UpstreamFailure {
    status?: number;
    code?: string;
    retryable: boolean;
}

function fields(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}

/** Handles SDK APIError and the structured error bodies used by compatible backends. */
export function classifyUpstreamFailure(error: unknown): UpstreamFailure | null {
    const top = fields(error);
    if (!top) return null;
    const body = fields(top.error) ?? fields(top.body);
    const nested = body ? fields(body.error) : null;
    const candidates = [top, body, nested].filter((item): item is Record<string, unknown> => item !== null);
    const status = candidates.map((item) => item.status).find((value): value is number =>
        typeof value === "number" && Number.isInteger(value));
    const code = candidates.map((item) => item.code).find((value): value is string => typeof value === "string");
    const retryable = candidates.some((item) => item.retryable === true) ||
        status !== undefined && [502, 503, 504, 520].includes(status) || code === "server_error";
    return retryable ? { status, code, retryable: true } : null;
}
