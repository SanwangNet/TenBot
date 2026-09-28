import type { LogEntry, RuntimeEvent, RuntimeStatus } from "./types.js";
import { apiClient, ApiError } from "./client.js";

export type RuntimeConnectionState = "connecting" | "online" | "reconnecting" | "offline";

export interface RuntimeEventHandlers {
    onStatus(status: RuntimeStatus): void;
    onLog(entry: LogEntry): void;
    onLogsSnapshot(entries: LogEntry[]): void;
    onRuntimeEvent(event: RuntimeEvent): void;
    onConnection(state: RuntimeConnectionState): void;
}

export function parseEventData<T>(data: string): T {
    return JSON.parse(data) as T;
}

export function connectRuntimeEvents(handlers: RuntimeEventHandlers): () => void {
    const source = new EventSource("/api/events");
    let checkingSession = false;
    source.onopen = () => handlers.onConnection("online");
    source.onerror = () => {
        handlers.onConnection(source.readyState === EventSource.CLOSED ? "offline" : "reconnecting");
        if (checkingSession || source.readyState === EventSource.CLOSED) return;
        checkingSession = true;
        void apiClient.getAuthMe().catch((cause: unknown) => {
            if (cause instanceof ApiError && cause.status === 401) source.close();
        }).finally(() => { checkingSession = false; });
    };
    source.addEventListener("status", (event) => {
        try { handlers.onStatus(parseEventData<RuntimeStatus>((event as MessageEvent<string>).data)); }
        catch { /* Ignore malformed frames and keep the stream available. */ }
    });
    source.addEventListener("log", (event) => {
        try { handlers.onLog(parseEventData<LogEntry>((event as MessageEvent<string>).data)); }
        catch { /* Ignore malformed frames and keep the stream available. */ }
    });
    source.addEventListener("logs-snapshot", (event) => {
        try { handlers.onLogsSnapshot(parseEventData<LogEntry[]>((event as MessageEvent<string>).data)); }
        catch { /* Ignore malformed frames and keep the stream available. */ }
    });
    source.addEventListener("runtime-event", (event) => {
        try { handlers.onRuntimeEvent(parseEventData<RuntimeEvent>((event as MessageEvent<string>).data)); }
        catch { /* Ignore malformed frames and keep the stream available. */ }
    });
    return () => source.close();
}
