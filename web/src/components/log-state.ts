import type { LogEntry } from "../api/types.js";

export const MAX_WEB_LOG_ENTRIES = 5_000;
export const MAX_RENDERED_LOG_ENTRIES = 500;
export type LogLevelFilter = "all" | "all-level" | Exclude<LogEntry["level"], "all">;

export interface LogViewState {
    /** Bounded canonical rows are mutated in place; rowsRevision drives list/filter recomputation. */
    entries: LogEntry[];
    rowsRevision: number;
    follow: boolean;
    unseenCount: number;
}

export const initialLogViewState: LogViewState = { entries: [], rowsRevision: 0, follow: true, unseenCount: 0 };

export type LogViewAction =
    | { type: "append"; entry: LogEntry }
    | { type: "append-batch"; entries: LogEntry[] }
    | { type: "snapshot"; entries: LogEntry[] }
    | { type: "clear" }
    | { type: "set-follow"; follow: boolean }
    | { type: "scroll-position"; atBottom: boolean };

export function logViewReducer(state: LogViewState, action: LogViewAction): LogViewState {
    switch (action.type) {
        case "append": return appendLogBatch(state, [action.entry]);
        case "append-batch": return appendLogBatch(state, action.entries);
        case "snapshot":
            return { ...state, entries: action.entries.slice(-MAX_WEB_LOG_ENTRIES), rowsRevision: state.rowsRevision + 1 };
        case "clear":
            return { ...state, entries: [], rowsRevision: state.rowsRevision + 1, unseenCount: 0 };
        case "set-follow":
            return { ...state, follow: action.follow, unseenCount: action.follow ? 0 : state.unseenCount };
        case "scroll-position":
            return { ...state, follow: action.atBottom, unseenCount: action.atBottom ? 0 : state.unseenCount };
        default:
            return state;
    }
}

function appendLogBatch(state: LogViewState, entries: readonly LogEntry[]): LogViewState {
    if (!entries.length) return state;
    let appended = 0;
    for (const entry of entries) {
        const last = state.entries.at(-1);
        if (last?.rowId && last.rowId === entry.rowId) {
            Object.assign(last, entry);
            continue;
        }
        state.entries.push(entry);
        appended++;
    }
    const excess = state.entries.length - MAX_WEB_LOG_ENTRIES;
    if (excess > 0) state.entries.splice(0, excess);
    return {
        ...state,
        rowsRevision: state.rowsRevision + (appended > 0 ? 1 : 0),
        unseenCount: state.follow ? 0 : state.unseenCount + appended,
    };
}

export class LogBatchQueue {
    private readonly pending: LogEntry[] = [];
    private scheduledHandle: unknown;
    private hasScheduled = false;
    private generation = 0;

    constructor(
        private readonly flush: (entries: LogEntry[]) => void,
        private readonly delayMs = 30,
        private readonly schedule: (callback: () => void, delayMs: number) => unknown = (callback, delay) => setTimeout(callback, delay),
        private readonly cancel: (handle: unknown) => void = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    ) {}

    enqueue(entry: LogEntry): void {
        this.pending.push(entry);
        if (this.hasScheduled) return;
        this.hasScheduled = true;
        const generation = this.generation;
        this.scheduledHandle = this.schedule(() => {
            if (generation !== this.generation) return;
            this.hasScheduled = false;
            const batch = this.pending.splice(0);
            if (batch.length) this.flush(batch);
        }, this.delayMs);
    }

    flushNow(): void {
        this.generation++;
        if (this.hasScheduled) this.cancel(this.scheduledHandle);
        this.hasScheduled = false;
        const batch = this.pending.splice(0);
        if (batch.length) this.flush(batch);
    }

    clear(): void {
        this.generation++;
        this.pending.length = 0;
        if (this.hasScheduled) this.cancel(this.scheduledHandle);
        this.hasScheduled = false;
    }

    dispose(): void { this.clear(); }
}

export function filterLogs(entries: readonly LogEntry[], level: LogLevelFilter, query: string): LogEntry[] {
    const normalized = query.trim().toLocaleLowerCase();
    return entries.filter((entry) =>
        (level === "all" || entry.level === (level === "all-level" ? "all" : level)) &&
        (!normalized || entry.text.toLocaleLowerCase().includes(normalized)));
}
