import type { LogEntry } from "../api/types.js";

export const MAX_WEB_LOG_ENTRIES = 1_000;
export type LogLevelFilter = "all" | LogEntry["level"];

export interface LogViewState {
    entries: LogEntry[];
    follow: boolean;
    unseenCount: number;
}

export const initialLogViewState: LogViewState = {
    entries: [],
    follow: true,
    unseenCount: 0,
};

export type LogViewAction =
    | { type: "append"; entry: LogEntry }
    | { type: "clear" }
    | { type: "set-follow"; follow: boolean }
    | { type: "scroll-position"; atBottom: boolean };

export function logViewReducer(state: LogViewState, action: LogViewAction): LogViewState {
    switch (action.type) {
        case "append":
            return {
                ...state,
                entries: [...state.entries, action.entry].slice(-MAX_WEB_LOG_ENTRIES),
                unseenCount: state.follow ? 0 : state.unseenCount + 1,
            };
        case "clear":
            return { ...state, entries: [], unseenCount: 0 };
        case "set-follow":
            return { ...state, follow: action.follow, unseenCount: action.follow ? 0 : state.unseenCount };
        case "scroll-position":
            return {
                ...state,
                follow: action.atBottom,
                unseenCount: action.atBottom ? 0 : state.unseenCount,
            };
        default:
            return state;
    }
}

export function filterLogs(entries: readonly LogEntry[], level: LogLevelFilter, query: string): LogEntry[] {
    const normalized = query.trim().toLocaleLowerCase();
    return entries.filter((entry) =>
        (level === "all" || entry.level === level) &&
        (!normalized || entry.text.toLocaleLowerCase().includes(normalized)));
}
