import { mkdir, appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { LogEntry } from "./logger.js";

/** Serial asynchronous daily append sink. Text variants are already sanitized by logger.ts. */
export class LogFileSink {
    private queue: Promise<void> = Promise.resolve();
    private closed = false;
    private failureReported = false;

    constructor(
        private readonly directory: string,
        private readonly onFailure: (error: unknown) => void = () => undefined,
    ) {}

    write(entry: LogEntry, allText = entry.text): void {
        if (this.closed) return;
        const date = new Date(entry.timestamp);
        const dateName = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
        const prefix = `${formatLocalTimestamp(date)} ${entry.level.toUpperCase()} `;
        const writes: Array<{ path: string; text: string }> = [
            { path: join(this.directory, `tenbot-${dateName}.all.log`), text: allText },
        ];
        if (entry.level !== "all" && entry.level !== "debug") {
            writes.push({ path: join(this.directory, `tenbot-${dateName}.info.log`), text: entry.text });
        }
        if (entry.level === "warn" || entry.level === "error") {
            writes.push({ path: join(this.directory, `tenbot-${dateName}.warn.log`), text: entry.text });
        }
        this.queue = this.queue.then(async () => {
            await mkdir(this.directory, { recursive: true });
            let firstError: unknown;
            for (const write of writes) {
                try {
                    await appendFile(write.path, `${prefix}${write.text}\n`, { encoding: "utf8", flag: "a" });
                } catch (error) {
                    firstError ??= error;
                }
            }
            if (firstError) throw firstError;
        }).catch((error: unknown) => {
            if (!this.failureReported) {
                this.failureReported = true;
                try { this.onFailure(error); } catch { /* Diagnostics must never escape the sink. */ }
            }
        });
    }

    async flush(): Promise<void> {
        await this.queue;
    }

    async close(): Promise<void> {
        this.closed = true;
        await this.queue;
    }
}

function pad(value: number): string { return String(value).padStart(2, "0"); }

function formatLocalTimestamp(date: Date): string {
    const offset = -date.getTimezoneOffset();
    const sign = offset >= 0 ? "+" : "-";
    const hours = Math.floor(Math.abs(offset) / 60);
    const minutes = Math.abs(offset) % 60;
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
        `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.` +
        `${String(date.getMilliseconds()).padStart(3, "0")}${sign}${pad(hours)}:${pad(minutes)}`;
}
