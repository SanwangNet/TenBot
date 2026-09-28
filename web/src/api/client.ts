import type {
    AuthMeResponse,
    ConfigPatchResponse,
    ConversationItem,
    ConversationSummary,
    GroupMemberSummary,
    GroupSummary,
    MemberBotState,
    EditorResource,
    EditorResourceId,
    EditorSaveResponse,
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
    getGroups: (signal?: AbortSignal) => getJson<GroupSummary[]>("/api/groups", signal),
    getMarkedBots: (signal?: AbortSignal) => getJson<GroupMemberSummary[]>("/api/members/marked-bots", signal),
    getGroupMembers: (groupOpenid: string, signal?: AbortSignal) =>
        getJson<GroupMemberSummary[]>(`/api/groups/${encodeURIComponent(groupOpenid)}/members`, signal),
    getGroupMember: (groupOpenid: string, memberOpenid: string, signal?: AbortSignal) =>
        getJson<GroupMemberSummary>(`/api/groups/${encodeURIComponent(groupOpenid)}/members/${encodeURIComponent(memberOpenid)}`, signal),
    setGroupRepliesEnabled: (groupOpenid: string, enabled: boolean, signal?: AbortSignal) =>
        sendJson<{ group: GroupSummary; changed: boolean }>(`/api/groups/${encodeURIComponent(groupOpenid)}/replies`, "PATCH", { enabled }, signal),
    setMemberManualBot: (groupOpenid: string, memberOpenid: string, enabled: boolean, signal?: AbortSignal) =>
        sendJson<{ state: MemberBotState; member: GroupMemberSummary | null }>(
            `/api/groups/${encodeURIComponent(groupOpenid)}/members/${encodeURIComponent(memberOpenid)}/manual-bot`, "PATCH", { enabled }, signal),
    clearMemberDetections: (groupOpenid: string, memberOpenid: string, signal?: AbortSignal) =>
        sendJson<{ state: MemberBotState; member: GroupMemberSummary | null }>(
            `/api/groups/${encodeURIComponent(groupOpenid)}/members/${encodeURIComponent(memberOpenid)}/clear-detections`, "POST", undefined, signal),
    getMemeLibrary: (signal?: AbortSignal) => getJson<MemeLibraryResponse>("/api/meme-library", signal),
    uploadMeme: (name: string, data: string, signal?: AbortSignal) =>
        sendJson<MemeUploadResponse>("/api/meme-library", "POST", { name, data }, signal),
    deleteMeme: (filename: string, signal?: AbortSignal) =>
        sendJson<MemeDeleteResponse>(`/api/meme-library/${encodeURIComponent(filename)}`, "DELETE", undefined, signal),
    memePreviewUrl: (filename: string) => `/api/meme-library/${encodeURIComponent(filename)}`,
    updateConfig: (patch: PublicConfigPatch, signal?: AbortSignal) =>
        sendJson<ConfigPatchResponse>("/api/config", "PATCH", patch, signal),
    getEditorResource: (id: EditorResourceId, signal?: AbortSignal) =>
        getJson<EditorResource>(`/api/editor/resources/${encodeURIComponent(id)}`, signal),
    saveEditorResource: (id: EditorResourceId, content: string, expectedVersion: string, signal?: AbortSignal) =>
        sendJson<EditorSaveResponse>(`/api/editor/resources/${encodeURIComponent(id)}`, "PUT", { content, expectedVersion }, signal),
};
