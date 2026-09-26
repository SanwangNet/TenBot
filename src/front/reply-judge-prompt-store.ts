import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";

export interface ReplyJudgePromptSnapshot {
    readonly content: string;
    readonly revision: number;
    readonly loadedAt: string;
}

function makeSnapshot(content: string, revision: number): ReplyJudgePromptSnapshot {
    if (!content.trim()) throw new Error("Reply Judge Prompt must not be empty");
    return Object.freeze({ content, revision, loadedAt: new Date().toISOString() });
}

const DEFAULT_PROMPT_PATH = new URL("../../prompts/reply-judge.md", import.meta.url);

/** Atomic prompt snapshots for Reply Judge requests. Failed reloads preserve the last snapshot. */
export class ReplyJudgePromptStore {
    private snapshot: ReplyJudgePromptSnapshot | undefined;

    constructor(private readonly path: URL | string = DEFAULT_PROMPT_PATH) {}

    get(): ReplyJudgePromptSnapshot {
        if (!this.snapshot) this.snapshot = makeSnapshot(readFileSync(this.path, "utf8"), 1);
        return this.snapshot;
    }

    getPath(): URL | string {
        return this.path;
    }

    async load(): Promise<ReplyJudgePromptSnapshot> {
        const content = await readFile(this.path, "utf8");
        const next = makeSnapshot(content, (this.snapshot?.revision ?? 0) + 1);
        this.snapshot = next;
        return next;
    }

    async reload(): Promise<ReplyJudgePromptSnapshot> {
        return this.load();
    }
}
