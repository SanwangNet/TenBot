import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function nativePath(value: URL | string): string {
    return resolve(value instanceof URL ? fileURLToPath(value) : value);
}

async function contentHash(path: string): Promise<string> {
    try {
        const content = await readFile(path);
        return createHash("sha256").update(content).digest("hex");
    } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return "<missing>";
        throw error;
    }
}

/** Watches a file through its parent directory so atomic rename saves remain observable. */
export class FileChangeWatcher {
    private watcher?: FSWatcher;
    private timer?: ReturnType<typeof setTimeout>;
    private lastHash?: string;
    private closed = false;
    private readonly path: string;

    constructor(path: URL | string, private readonly onChange: () => void | Promise<void>, private readonly debounceMs = 300) {
        this.path = nativePath(path);
    }

    async start(): Promise<void> {
        try {
            this.lastHash = await contentHash(this.path);
            this.watcher = watch(dirname(this.path), { persistent: false }, (_event, filename) => {
                if (filename && String(filename).toLocaleLowerCase() !== basename(this.path).toLocaleLowerCase()) return;
                this.schedule();
            });
            this.watcher.on("error", () => this.close());
        } catch {
            // File watching is an enhancement; the keyboard control surface stays usable.
            this.watcher = undefined;
        }
    }

    private schedule(): void {
        if (this.closed) return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => { void this.check(); }, this.debounceMs);
        this.timer.unref?.();
    }

    private async check(): Promise<void> {
        this.timer = undefined;
        if (this.closed) return;
        let nextHash: string;
        try { nextHash = await contentHash(this.path); }
        catch { return; }
        if (nextHash === this.lastHash) return;
        this.lastHash = nextHash;
        try { await this.onChange(); } catch { /* Runtime reports a safe reload failure. */ }
    }

    async markCurrent(): Promise<void> {
        try { this.lastHash = await contentHash(this.path); } catch { /* Keep the last known revision. */ }
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
        this.watcher?.close();
        this.watcher = undefined;
    }
}
