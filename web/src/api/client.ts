import type {
    AutomatedPeerSummary,
    ConfigPatchResponse,
    ConversationItem,
    ConversationSummary,
    KnownMemberSummary,
    PublicConfig,
    PublicConfigPatch,
    RuntimeStatus,
} from "./types.js";

export class ApiError extends Error {
    constructor(message: string, readonly status?: number) {
        super(message);
        this.name = "ApiError";
    }
}

export function parseJsonResponse<T>(status: number, body: string): T {
    let parsed: unknown;
    try { parsed = JSON.parse(body) as unknown; }
    catch {
        throw new ApiError(status >= 200 && status < 300
            ? "TenBot Runtime returned invalid JSON"
            : `Request failed (HTTP ${status})`, status);
    }

    if (status < 200 || status >= 300) {
        const message = typeof parsed === "object" && parsed !== null && "error" in parsed &&
            typeof parsed.error === "object" && parsed.error !== null && "message" in parsed.error &&
            typeof parsed.error.message === "string"
            ? parsed.error.message
            : `Request failed (HTTP ${status})`;
        throw new ApiError(message, status);
    }
    return parsed as T;
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
    let response: Response;
    try { response = await fetch(path, { method: "GET", headers: { Accept: "application/json" }, signal }); }
    catch (cause) {
        if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
        throw new ApiError("Unable to connect to TenBot Runtime");
    }
    return parseJsonResponse<T>(response.status, await response.text());
}

async function sendJson<T>(path: string, method: "PATCH", body: unknown, signal?: AbortSignal): Promise<T> {
    let response: Response;
    try {
        response = await fetch(path, {
            method,
            headers: { Accept: "application/json", "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal,
        });
    } catch (cause) {
        if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
        throw new ApiError("Unable to connect to TenBot Runtime");
    }
    return parseJsonResponse<T>(response.status, await response.text());
}

export const apiClient = {
    getStatus: (signal?: AbortSignal) => getJson<RuntimeStatus>("/api/status", signal),
    getConfig: (signal?: AbortSignal) => getJson<PublicConfig>("/api/config", signal),
    getConversations: (signal?: AbortSignal) => getJson<ConversationSummary[]>("/api/conversations", signal),
    getConversation: (id: string, signal?: AbortSignal) =>
        getJson<ConversationItem[]>(`/api/conversations/${encodeURIComponent(id)}`, signal),
    getAutomatedPeers: (signal?: AbortSignal) => getJson<{ registered: AutomatedPeerSummary[]; recent: AutomatedPeerSummary[] }>("/api/automated-peers", signal),
    getKnownMembers: (signal?: AbortSignal) => getJson<KnownMemberSummary[]>("/api/known-members", signal),
    updateConfig: (patch: PublicConfigPatch, signal?: AbortSignal) =>
        sendJson<ConfigPatchResponse>("/api/config", "PATCH", patch, signal),
};
