import { subscribeLogs, type LogEntry, type LogListener } from "../shared/logger.js";
import { MAX_TUI_LOG_ENTRIES } from "./tenbot-control.js";

export class LogBuffer {
    private readonly entries: LogEntry[] = [];
    private readonly listeners = new Set<LogListener>();
    private readonly unsubscribeLogger: () => void;

    constructor(private readonly limit = MAX_TUI_LOG_ENTRIES) {
        this.unsubscribeLogger = subscribeLogs((entry) => this.push(entry));
    }

    getEntries(): readonly LogEntry[] {
        return [...this.entries];
    }

    subscribe(listener: LogListener): () => void {
        this.listeners.add(listener);
        for (const entry of this.entries) listener(entry);
        return () => this.listeners.delete(listener);
    }

    dispose(): void {
        this.unsubscribeLogger();
        this.listeners.clear();
    }

    private push(entry: LogEntry): void {
        this.entries.push(Object.freeze({ ...entry }));
        if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
        for (const listener of this.listeners) {
            try { listener(entry); } catch { /* UI listeners cannot block Runtime logging. */ }
        }
    }
}
