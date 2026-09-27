import { randomUUID } from "node:crypto";
import { subscribeLogs, type LogEntry, type LogListener } from "../shared/logger.js";
import { MAX_LOG_BUFFER_ENTRIES } from "./tenbot-control.js";

/** Canonical UI log rows: adjacent identical level/text events update one bounded row. */
export class LogBuffer {
    private readonly entries: Array<LogEntry | undefined>;
    private readonly listeners = new Set<LogListener>();
    private readonly unsubscribeLogger: () => void;
    private head = 0;
    private count = 0;

    constructor(private readonly limit = MAX_LOG_BUFFER_ENTRIES) {
        this.limit = Math.max(1, Math.floor(limit));
        this.entries = new Array(this.limit);
        this.unsubscribeLogger = subscribeLogs((entry) => this.push(entry));
    }

    getEntries(): readonly LogEntry[] {
        const result: LogEntry[] = [];
        for (let index = 0; index < this.count; index++) {
            const entry = this.entries[(this.head + index) % this.limit];
            if (entry) result.push(entry);
        }
        return result;
    }

    subscribe(listener: LogListener): () => void {
        this.listeners.add(listener);
        for (const entry of this.getEntries()) listener(entry);
        return () => this.listeners.delete(listener);
    }

    dispose(): void {
        this.unsubscribeLogger();
        this.listeners.clear();
    }

    private push(rawEntry: LogEntry): void {
        const previousIndex = (this.head + this.count - 1 + this.limit) % this.limit;
        const previous = this.count > 0 ? this.entries[previousIndex] : undefined;
        let entry: LogEntry;
        if (previous && previous.level === rawEntry.level && previous.text === rawEntry.text) {
            entry = Object.freeze({
                ...previous,
                timestamp: rawEntry.timestamp,
                repeatCount: (previous.repeatCount ?? 1) + 1,
            });
            this.entries[previousIndex] = entry;
        } else {
            entry = Object.freeze({
                ...rawEntry,
                rowId: randomUUID(),
                repeatCount: 1,
                firstTimestamp: rawEntry.timestamp,
            });
            if (this.count < this.limit) {
                const insertionIndex = (this.head + this.count) % this.limit;
                this.entries[insertionIndex] = entry;
                this.count++;
            } else {
                this.entries[this.head] = entry;
                this.head = (this.head + 1) % this.limit;
            }
        }
        for (const listener of this.listeners) {
            try { listener(entry); } catch { /* UI listeners cannot block Runtime logging. */ }
        }
    }
}
