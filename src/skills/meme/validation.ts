import type { MemeCandidate, MemeEntry, MemeInteraction } from "./types.js";
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

function interactionList(value: unknown): MemeInteraction[] | null {
    if (!Array.isArray(value) || value.length > 10) return null;
    const interactions: MemeInteraction[] = [];
    for (const item of value) {
        if (!item || typeof item !== "object" || Array.isArray(item)) return null;
        const interaction = item as Record<string, unknown>;
        const input = shortText(interaction.input, 160);
        if (!input || !Array.isArray(interaction.responses) ||
            interaction.responses.length < 1 || interaction.responses.length > 5) return null;
        const responses: string[] = [];
        for (const response of interaction.responses) {
            const text = shortText(response, 160);
            if (!text) return null;
            if (!responses.includes(text)) responses.push(text);
        }
        interactions.push({ input, responses });
    }
    return interactions;
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
    const interactions = v.interactions === undefined ? undefined : interactionList(v.interactions);
    if (!name || !summary || !origin || !meaning || !usage || !aliases || !examples || interactions === null) return null;
    return { name, aliases: aliases.filter((alias) => alias !== name), summary, origin,
        meaning, usage, examples, ...(interactions === undefined ? {} : { interactions }) };
}

export function validateMemeEntry(value: unknown): MemeEntry | null {
    const candidate = validateMemeCandidate(value);
    const v = value as Record<string, unknown> | null;
    if (!candidate || !v || typeof v.id !== "string" || !/^[a-z0-9-]{4,100}$/.test(v.id)) return null;
    return { id: v.id, ...candidate };
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
