import type { MemeEntry } from "./types.js";

export function normalizeMemeTerm(value: string): string {
    return value.trim().toLocaleLowerCase().replace(/[\s\u3000]+/g, "");
}

export function searchMemes(entries: readonly MemeEntry[], query: string, limit = 3): MemeEntry[] {
    const raw = query.trim();
    const normalized = normalizeMemeTerm(raw);
    if (!normalized) return [];
    return entries.map((entry, index) => {
        const terms = [entry.name, ...entry.aliases];
        let score = 0;
        if (entry.name === raw) score = 5;
        else if (entry.aliases.includes(raw)) score = 4;
        else if (normalizeMemeTerm(entry.name) === normalized) score = 3;
        else if (entry.aliases.some((alias) => normalizeMemeTerm(alias) === normalized)) score = 2;
        else if (terms.some((term) => normalizeMemeTerm(term).includes(normalized) || normalized.includes(normalizeMemeTerm(term)))) score = 1;
        return { entry, index, score };
    }).filter((match) => match.score > 0)
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .slice(0, Math.max(0, Math.min(limit, 3)))
        .map((match) => match.entry);
}
