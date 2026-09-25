import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";

export type PromptProvider = "gpt" | "deepseek";

export interface PromptSnapshot {
    provider: PromptProvider;
    content: string;
    loadedAt: string;
    revision: number;
}

export type PromptPaths = Readonly<Record<PromptProvider, URL | string>>;

const defaultPaths: PromptPaths = {
    gpt: new URL("./plugins/gpt/prompt.md", import.meta.url),
    deepseek: new URL("./plugins/deepseek/prompt.md", import.meta.url),
};

function makeSnapshot(provider: PromptProvider, content: string, revision: number): PromptSnapshot {
    if (!content.trim()) throw new Error(`${provider} Prompt must not be empty`);
    return Object.freeze({ provider, content, loadedAt: new Date().toISOString(), revision });
}

/** Runtime-loaded prompt snapshots. A failed reload leaves the prior snapshot untouched. */
export class PromptStore {
    private readonly snapshots = new Map<PromptProvider, PromptSnapshot>();

    constructor(private readonly paths: PromptPaths = defaultPaths) {}

    get(provider: PromptProvider): PromptSnapshot {
        let snapshot = this.snapshots.get(provider);
        if (!snapshot) {
            snapshot = makeSnapshot(provider, readFileSync(this.paths[provider], "utf8"), 1);
            this.snapshots.set(provider, snapshot);
        }
        return snapshot;
    }

    getForModel(modelId: string): PromptSnapshot | undefined {
        if (modelId !== "gpt" && modelId !== "deepseek") return undefined;
        return this.get(modelId);
    }

    async load(provider: PromptProvider): Promise<PromptSnapshot> {
        const content = await readFile(this.paths[provider], "utf8");
        const snapshot = makeSnapshot(provider, content, (this.snapshots.get(provider)?.revision ?? 0) + 1);
        this.snapshots.set(provider, snapshot);
        return snapshot;
    }

    async loadAll(): Promise<void> {
        const loaded = await Promise.all((Object.keys(this.paths) as PromptProvider[]).map(async (provider) => {
            const content = await readFile(this.paths[provider], "utf8");
            return [provider, makeSnapshot(provider, content, (this.snapshots.get(provider)?.revision ?? 0) + 1)] as const;
        }));
        for (const [provider, snapshot] of loaded) this.snapshots.set(provider, snapshot);
    }

    async reload(provider: PromptProvider): Promise<PromptSnapshot> {
        const content = await readFile(this.paths[provider], "utf8");
        const snapshot = makeSnapshot(provider, content, (this.snapshots.get(provider)?.revision ?? 0) + 1);
        this.snapshots.set(provider, snapshot);
        return snapshot;
    }

    getLoaded(provider: PromptProvider): PromptSnapshot | undefined {
        return this.snapshots.get(provider);
    }

    getPath(provider: PromptProvider): URL | string {
        return this.paths[provider];
    }
}

let activePromptStore: PromptStore | undefined;

export function getPromptStore(): PromptStore {
    return activePromptStore ??= new PromptStore();
}
