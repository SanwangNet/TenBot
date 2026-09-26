import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { writeFileAtomically } from "../config/env-document.js";
import { validateMemeFile } from "../skills/meme/validation.js";
import type { ReloadResult } from "./tenbot-control.js";

export const EDITOR_RESOURCE_IDS = ["prompt:gpt", "prompt:deepseek", "prompt:reply-judge", "meme:data"] as const;
export type EditorResourceId = typeof EDITOR_RESOURCE_IDS[number];

export function isEditorResourceId(value: string): value is EditorResourceId {
    return (EDITOR_RESOURCE_IDS as readonly string[]).includes(value);
}

export interface EditorResource {
    id: EditorResourceId;
    displayName: string;
    language: "markdown" | "json";
    content: string;
    version: string;
}

export type EditorSaveResult =
    | { ok: true; resource: EditorResource; reload: ReloadResult }
    | { ok: false; reason: "conflict"; message: string }
    | { ok: false; reason: "invalid"; message: string };

export interface EditorResourceDefinition {
    path: URL | string;
    displayName: string;
    language: "markdown" | "json";
    reload(): Promise<ReloadResult>;
}

export type EditorResourceDefinitions = Record<EditorResourceId, EditorResourceDefinition>;

function pathString(path: URL | string): string {
    return path instanceof URL ? fileURLToPath(path) : path;
}

function versionOf(content: string): string {
    return createHash("sha256").update(content, "utf8").digest("hex");
}

function validateCandidate(id: EditorResourceId, content: string): string | undefined {
    if (id !== "meme:data") return content.trim() ? undefined : "Prompt must not be empty";
    let parsed: unknown;
    try { parsed = JSON.parse(content) as unknown; }
    catch { return "Invalid JSON"; }
    try { validateMemeFile(parsed); }
    catch (cause) { return cause instanceof Error ? cause.message : "Invalid Meme data"; }
    return undefined;
}

/** The fixed definitions are created inside Runtime; callers can only choose a resource ID. */
export function createEditorResourceStore(definitions: EditorResourceDefinitions) {
    const queues = new Map<EditorResourceId, Promise<void>>();

    async function get(id: EditorResourceId): Promise<EditorResource> {
        if (!isEditorResourceId(id)) throw new Error("Unknown editor resource");
        const definition = definitions[id];
        const content = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(definition.path));
        return { id, displayName: definition.displayName, language: definition.language, content, version: versionOf(content) };
    }

    async function save(id: EditorResourceId, content: string, expectedVersion: string): Promise<EditorSaveResult> {
        if (!isEditorResourceId(id)) throw new Error("Unknown editor resource");
        const previous = queues.get(id) ?? Promise.resolve();
        let release!: () => void;
        const current = new Promise<void>((resolve) => { release = resolve; });
        const tail = previous.then(() => current);
        queues.set(id, tail);
        await previous;
        try {
            const existing = await get(id);
            if (existing.version !== expectedVersion) {
                return { ok: false, reason: "conflict", message: "File changed on the server" };
            }
            const validationError = validateCandidate(id, content);
            if (validationError) return { ok: false, reason: "invalid", message: validationError };
            if (Buffer.from(content, "utf8").toString("utf8") !== content) {
                return { ok: false, reason: "invalid", message: "Resource must contain valid UTF-8 text" };
            }
            if ((await get(id)).version !== expectedVersion) {
                return { ok: false, reason: "conflict", message: "File changed on the server" };
            }
            await writeFileAtomically(pathString(definitions[id].path), content);
            let reload: ReloadResult;
            try { reload = await definitions[id].reload(); }
            catch { reload = { ok: false, message: "Runtime reload failed; previous snapshot remains active" }; }
            return { ok: true, resource: await get(id), reload };
        } finally {
            release();
            if (queues.get(id) === tail) queues.delete(id);
        }
    }

    return { get, save };
}
