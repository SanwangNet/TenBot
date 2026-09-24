import type { MemeCandidate, MemeEntry, MemeSource } from "./types.js";
import { normalizeMemeTerm } from "./search.js";

const limits = { name: 80, summary: 240, origin: 500, meaning: 400, usage: 400 } as const;

function shortText(value: unknown, limit: number, required = true): string | null {
    if (typeof value !== "string") return null;
    const text = value.trim();
    return ((!required || text.length > 0) && text.length <= limit) ? text : null;
}

function textList(value: unknown, limit: number, count: number): string[] | null {
    if (!Array.isArray(value) || value.length > count * 3) return null;
    const output: string[] = [];
    for (const item of value) {
        const text = shortText(item, limit, false);
        if (text === null) return null;
        if (text && !output.includes(text)) output.push(text);
    }
    return output.slice(0, count);
}

export function validateMemeCandidate(value: unknown): MemeCandidate | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const v = value as Record<string, unknown>;
    const name = shortText(v.name, limits.name);
    const summary = shortText(v.summary, limits.summary);
    const origin = shortText(v.origin, limits.origin);
    const meaning = shortText(v.meaning, limits.meaning);
    const usage = shortText(v.usage, limits.usage);
    const aliases = textList(v.aliases, 80, 12);
    const examples = textList(v.examples, 120, 3);
    if (!name || !summary || !origin || !meaning || !usage || !aliases || !examples ||
        !Array.isArray(v.sources) || v.sources.length === 0 || v.sources.length > 20) return null;
    const sources: MemeSource[] = [];
    for (const item of v.sources) {
        if (!item || typeof item !== "object") return null;
        const source = item as Record<string, unknown>;
        const sourceName = shortText(source.name, 100);
        const urlText = shortText(source.url, 2048);
        if (!sourceName || !urlText) return null;
        try {
            const url = new URL(urlText);
            if (!(["http:", "https:"].includes(url.protocol)) || !url.hostname) return null;
        } catch { return null; }
        if (!sources.some((existing) => existing.url === urlText)) sources.push({ name: sourceName, url: urlText });
    }
    return { name, aliases: aliases.filter((alias) => alias !== name), summary, origin,
        meaning, usage, examples, sources };
}

export function validateMemeEntry(value: unknown): MemeEntry | null {
    const candidate = validateMemeCandidate(value);
    const v = value as Record<string, unknown> | null;
    if (!candidate || !v || typeof v.id !== "string" || !/^[a-z0-9-]{4,100}$/.test(v.id) ||
        typeof v.firstSeenAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v.firstSeenAt) ||
        typeof v.updatedAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v.updatedAt)) return null;
    return { id: v.id, ...candidate, firstSeenAt: v.firstSeenAt, updatedAt: v.updatedAt };
}

export function validateMemeFile(value: unknown): MemeEntry[] {
    if (!Array.isArray(value)) throw new Error("Meme knowledge must be an array");
    const entries = value.map(validateMemeEntry);
    if (entries.some((entry) => entry === null)) throw new Error("Invalid MemeEntry in knowledge file");
    const valid = entries as MemeEntry[];
    const ids = new Set(valid.map((entry) => entry.id));
    if (ids.size !== valid.length) throw new Error("Duplicate MemeEntry id");
    const terms = new Map<string, string>();
    for (const entry of valid) {
        for (const term of [entry.name, ...entry.aliases]) {
            const key = normalizeMemeTerm(term);
            const owner = terms.get(key);
            if (owner && owner !== entry.id) throw new Error("Duplicate MemeEntry name or alias");
            terms.set(key, entry.id);
        }
    }
    return valid;
}
