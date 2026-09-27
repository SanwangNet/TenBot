import type { LogEntry } from "../shared/logger.js";
import { formatTuiLogText } from "./i18n.js";

export interface CollapsedLogRow {
    entry: LogEntry;
    displayText: string;
    count: number;
}

/** UI adapter for canonical LogBuffer rows; never performs a second collapse. */
export function collapseAdjacentLogs(entries: readonly LogEntry[]): CollapsedLogRow[] {
    return entries.map((entry) => ({ entry, displayText: formatTuiLogText(entry), count: entry.repeatCount ?? 1 }));
}
