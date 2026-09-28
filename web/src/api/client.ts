import type {
    AutomatedPeerSummary,
    AutomatedPeerMutationResult,
    AuthMeResponse,
    ConfigPatchResponse,
    ConversationItem,
    ConversationSummary,
    EditorResource,
    EditorResourceId,
    EditorSaveResponse,
    KnownMemberSummary,
    MemeLibraryResponse,
    MemeUploadResponse,
    MemeDeleteResponse,
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

let unauthorizedHandler: (() => void) | undefined;

export function setUnauthorizedHandler(handler: (() => void) | undefined): void {
    unauthorizedHandler = handler;
}

function handleUnauthorized(status: number): void {
    if (status === 401) unauthorizedHandler?.();
}

export function parseJsonResponse<T>(status: number, body: string): T {
    let parsed: unknown;
    try { parsed = JSON.parse(body) as unknown; }
    catch {
        throw new ApiError(status >= 200 && status < 300
            ? "TenBot 运行时返回了无效 JSON"
            : `请求失败（HTTP ${status}）`, status);
    }

    if (status < 200 || status >= 300) {
        const message = typeof parsed === "object" && parsed !== null && "error" in parsed &&
            typeof parsed.error === "object" && parsed.error !== null && "message" in parsed.error &&
            typeof parsed.error.message === "string"
            ? parsed.error.message
            : `请求失败（HTTP ${status}）`;
        throw new ApiError(message, status);
    }
    return parsed as T;
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
    let response: Response;
    try { response = await fetch(path, { method: "GET", headers: { Accept: "application/json" }, signal }); }
    catch (cause) {
        if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
        throw new ApiError("无法连接到 TenBot 运行时");
    }
    const body = await response.text();
    handleUnauthorized(response.status);
    return parseJsonResponse<T>(response.status, body);
}

async function sendJson<T>(path: string, method: "PATCH" | "POST" | "PUT" | "DELETE", body?: unknown, signal?: AbortSignal): Promise<T> {
    let response: Response;
    try {
        response = await fetch(path, {
            method,
            headers: { Accept: "application/json", "Content-Type": "application/json" },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal,
        });
    } catch (cause) {
        if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
        throw new ApiError("无法连接到 TenBot 运行时");
    }
    const responseBody = await response.text();
    handleUnauthorized(response.status);
    return parseJsonResponse<T>(response.status, responseBody);
}

export const apiClient = {
    getAuthMe: (signal?: AbortSignal) => getJson<AuthMeResponse>("/api/auth/me", signal),
    logout: () => sendJson<{ ok: true }>("/api/auth/logout", "POST"),
    getStatus: (signal?: AbortSignal) => getJson<RuntimeStatus>("/api/status", signal),
    getConfig: (signal?: AbortSignal) => getJson<PublicConfig>("/api/config", signal),
    getConversations: (signal?: AbortSignal) => getJson<ConversationSummary[]>("/api/conversations", signal),
    getConversation: (id: string, signal?: AbortSignal) =>
        getJson<ConversationItem[]>(`/api/conversations/${encodeURIComponent(id)}`, signal),
    getAutomatedPeers: (signal?: AbortSignal) => getJson<{ registered: AutomatedPeerSummary[]; recent: AutomatedPeerSummary[] }>("/api/automated-peers", signal),
    getKnownMembers: (signal?: AbortSignal) => getJson<KnownMemberSummary[]>("/api/known-members", signal),
    getMemeLibrary: (signal?: AbortSignal) => getJson<MemeLibraryResponse>("/api/meme-library", signal),
    uploadMeme: (name: string, data: string, signal?: AbortSignal) =>
        sendJson<MemeUploadResponse>("/api/meme-library", "POST", { name, data }, signal),
    deleteMeme: (filename: string, signal?: AbortSignal) =>
        sendJson<MemeDeleteResponse>(`/api/meme-library/${encodeURIComponent(filename)}`, "DELETE", undefined, signal),
    memePreviewUrl: (filename: string) => `/api/meme-library/${encodeURIComponent(filename)}`,
    updateConfig: (patch: PublicConfigPatch, signal?: AbortSignal) =>
        sendJson<ConfigPatchResponse>("/api/config", "PATCH", patch, signal),
    addAutomatedPeer: (id: string, signal?: AbortSignal) =>
        sendJson<AutomatedPeerMutationResult>("/api/automated-peers", "POST", { id }, signal),
    removeAutomatedPeer: (id: string, signal?: AbortSignal) =>
        sendJson<AutomatedPeerMutationResult>(`/api/automated-peers/${encodeURIComponent(id)}`, "DELETE", undefined, signal),
    getEditorResource: (id: EditorResourceId, signal?: AbortSignal) =>
        getJson<EditorResource>(`/api/editor/resources/${encodeURIComponent(id)}`, signal),
    saveEditorResource: (id: EditorResourceId, content: string, expectedVersion: string, signal?: AbortSignal) =>
        sendJson<EditorSaveResponse>(`/api/editor/resources/${encodeURIComponent(id)}`, "PUT", { content, expectedVersion }, signal),
};
