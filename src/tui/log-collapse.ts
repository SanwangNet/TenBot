import type { LogEntry } from "../shared/logger.js";
import { formatTuiLogText } from "./i18n.js";

export interface CollapsedLogRow {
    entry: LogEntry;
    displayText: string;
    count: number;
}

/** Collapse only adjacent rows whose level and localized display text match. */
export function collapseAdjacentLogs(entries: readonly LogEntry[]): CollapsedLogRow[] {
    const rows: CollapsedLogRow[] = [];
    for (const entry of entries) {
        const displayText = formatTuiLogText(entry);
        const previous = rows.at(-1);
        if (previous && previous.entry.level === entry.level && previous.displayText === displayText) {
            previous.entry = entry;
            previous.count++;
        } else rows.push({ entry, displayText, count: 1 });
    }
    return rows;
}
