import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createMemeSearchIndex, type MemeSearchIndex } from "./search.js";
import type { MemeEntry } from "./types.js";

export function sampleRecentMemeNames(entries: readonly MemeEntry[], limit = 5): string[] {
    if (!Number.isSafeInteger(limit) || limit < 1) return [];
    return entries.slice(-limit).map((entry) => entry.name);
}
import { validateMemeFile } from "./validation.js";

export interface MemeRuntimeSnapshot {
    readonly entries: readonly MemeEntry[];
    readonly index: MemeSearchIndex;
    readonly loadedAt: string;
    readonly revision: number;
}

function createSnapshot(value: unknown, revision: number): MemeRuntimeSnapshot {
    const entries = Object.freeze(validateMemeFile(value));
    return Object.freeze({ entries, index: createMemeSearchIndex(entries), loadedAt: new Date().toISOString(), revision });
}

/** Rebuilds and validates the complete index before atomically replacing the current snapshot. */
export class MemeStore {
    private snapshot?: MemeRuntimeSnapshot;

    constructor(private readonly dataPath: URL | string = new URL("./data/memes.json", import.meta.url)) {}

    getPath(): URL | string {
        return this.dataPath;
    }

    getSnapshot(): MemeRuntimeSnapshot {
        return this.snapshot ??= createSnapshot(JSON.parse(readFileSync(this.dataPath, "utf8")), 1);
    }

    async loadInitial(): Promise<MemeRuntimeSnapshot> {
        if (this.snapshot) return this.snapshot;
        const raw = await readFile(this.dataPath, "utf8");
        const initial = createSnapshot(JSON.parse(raw) as unknown, 1);
        this.snapshot ??= initial;
        return this.snapshot;
    }

    async reload(): Promise<MemeRuntimeSnapshot> {
        const previous = this.snapshot;
        if (!previous) return this.loadInitial();
        const raw = await readFile(this.dataPath, "utf8");
        const next = createSnapshot(JSON.parse(raw) as unknown, previous.revision + 1);
        this.snapshot = next;
        return next;
    }
}

export const memeStore = new MemeStore();
