import type { LogEntry, RuntimeEvent, RuntimeStatus } from "./types.js";

export type RuntimeConnectionState = "connecting" | "online" | "reconnecting" | "offline";

export interface RuntimeEventHandlers {
    onStatus(status: RuntimeStatus): void;
    onLog(entry: LogEntry): void;
    onRuntimeEvent(event: RuntimeEvent): void;
    onConnection(state: RuntimeConnectionState): void;
}

export function parseEventData<T>(data: string): T {
    return JSON.parse(data) as T;
}

export function connectRuntimeEvents(handlers: RuntimeEventHandlers): () => void {
    const source = new EventSource("/api/events");
    source.onopen = () => handlers.onConnection("online");
    source.onerror = () => handlers.onConnection(source.readyState === EventSource.CLOSED ? "offline" : "reconnecting");
    source.addEventListener("status", (event) => {
        try { handlers.onStatus(parseEventData<RuntimeStatus>((event as MessageEvent<string>).data)); }
        catch { /* Ignore malformed frames and keep the stream available. */ }
    });
    source.addEventListener("log", (event) => {
        try { handlers.onLog(parseEventData<LogEntry>((event as MessageEvent<string>).data)); }
        catch { /* Ignore malformed frames and keep the stream available. */ }
    });
    source.addEventListener("runtime-event", (event) => {
        try { handlers.onRuntimeEvent(parseEventData<RuntimeEvent>((event as MessageEvent<string>).data)); }
        catch { /* Ignore malformed frames and keep the stream available. */ }
    });
    return () => source.close();
}
