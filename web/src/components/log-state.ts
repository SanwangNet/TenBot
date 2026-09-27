import type { LogEntry } from "../api/types.js";

export const MAX_WEB_LOG_ENTRIES = 5_000;
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
    | { type: "snapshot"; entries: LogEntry[] }
    | { type: "clear" }
    | { type: "set-follow"; follow: boolean }
    | { type: "scroll-position"; atBottom: boolean };

export function logViewReducer(state: LogViewState, action: LogViewAction): LogViewState {
    switch (action.type) {
        case "append": {
            const last = state.entries.at(-1);
            if (last?.rowId && last.rowId === action.entry.rowId) {
                Object.assign(last, action.entry);
                return { ...state };
            }
            state.entries.push(action.entry);
            if (state.entries.length > MAX_WEB_LOG_ENTRIES) state.entries.shift();
            return {
                ...state,
                rowsRevision: state.rowsRevision + 1,
                unseenCount: state.follow ? 0 : state.unseenCount + 1,
            };
        }
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

export function filterLogs(entries: readonly LogEntry[], level: LogLevelFilter, query: string): LogEntry[] {
    const normalized = query.trim().toLocaleLowerCase();
    return entries.filter((entry) =>
        (level === "all" || entry.level === (level === "all-level" ? "all" : level)) &&
        (!normalized || entry.text.toLocaleLowerCase().includes(normalized)));
}
