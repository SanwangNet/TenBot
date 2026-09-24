import { pinyin } from "pinyin-pro";
import type { MemeEntry } from "./types.js";

export type MatchStrength = "STRONG" | "WEAK";

interface SearchVariant {
    normalized: string;
    fullPinyin?: string;
    pinyinInitials?: string;
}

interface IndexedMeme {
    entry: MemeEntry;
    index: number;
    terms: SearchVariant[];
}

export interface MemeMatch {
    entry: MemeEntry;
    score: number;
    strength: MatchStrength;
}

export interface MemeSearchIndex {
    readonly items: readonly IndexedMeme[];
}

export function normalizeMemeTerm(value: string): string {
    return value.trim().toLocaleLowerCase().replace(/[\s\u3000]+/g, "");
}

function searchVariant(value: string): SearchVariant {
    const normalized = normalizeMemeTerm(value).replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "");
    if (!/\p{Script=Han}/u.test(normalized)) return { normalized };
    const parts = normalized.match(/\p{Script=Han}+|[a-z0-9]+/gu) ?? [];
    const full: string[] = [];
    const initials: string[] = [];
    for (const part of parts) {
        if (!/\p{Script=Han}/u.test(part)) {
            full.push(part);
            initials.push(part);
            continue;
        }
        const syllables = pinyin(part, { toneType: "none", type: "array" }) as string[];
        full.push(...syllables);
        initials.push(...syllables.map((syllable) => syllable[0] ?? ""));
    }
    return { normalized, fullPinyin: full.join("").toLowerCase(), pinyinInitials: initials.join("").toLowerCase() };
}

export function createMemeSearchIndex(entries: readonly MemeEntry[]): MemeSearchIndex {
    return { items: entries.map((entry, index) => ({
        entry, index, terms: [entry.name, ...entry.aliases].map(searchVariant),
    })) };
}

function commonSubstring(a: string, b: string): number {
    let best = 0;
    let previous = new Array<number>(b.length + 1).fill(0);
    for (const character of a) {
        const current = new Array<number>(b.length + 1).fill(0);
        for (let j = 0; j < b.length; j++) {
            if (character === b[j]) best = Math.max(best, current[j + 1] = previous[j] + 1);
        }
        previous = current;
    }
    return best;
}

function isSubsequence(needle: string, haystack: string): boolean {
    let index = 0;
    for (const char of haystack) if (char === needle[index]) index++;
    return index === needle.length;
}

function overlap(a: string, b: string): number {
    const remaining = new Set(b);
    let count = 0;
    for (const char of new Set(a)) if (remaining.delete(char)) count++;
    return count;
}

function compare(query: SearchVariant, term: SearchVariant, name: boolean): number {
    const q = query.normalized;
    const t = term.normalized;
    if (!q || !t) return 0;
    if (q === t) return name ? 1000 : 980;
    const qFull = query.fullPinyin ?? q;
    const qInitials = query.pinyinInitials ?? q;
    if (term.fullPinyin && qFull === term.fullPinyin && qFull.length >= 4) return 920;
    if (term.pinyinInitials && qInitials === term.pinyinInitials && qInitials.length >= 3) return 900;
    if (q.includes(t) || t.includes(q)) {
        const shorter = Math.min(q.length, t.length);
        if (shorter >= 3) return 700 + Math.min(shorter, 30);
        if (shorter >= 2) return 300;
    }
    if (term.fullPinyin && (qFull.includes(term.fullPinyin) || term.fullPinyin.includes(qFull)) && qFull.length >= 4) {
        const shorter = Math.min(qFull.length, term.fullPinyin.length);
        if (shorter >= 4) return 600 + Math.min(shorter, 30);
    }
    if (term.pinyinInitials && qInitials.length >= 3) {
        const initials = term.pinyinInitials;
        const shorter = Math.min(qInitials.length, initials.length);
        if (shorter >= 3 && (qInitials.includes(initials) || initials.includes(qInitials))) {
            return shorter >= 4 ? 500 + shorter : 350 + shorter;
        }
        if (qInitials.length <= initials.length && isSubsequence(qInitials, initials)) {
            return qInitials.length >= 4 ? 420 + qInitials.length : 250 + qInitials.length;
        }
    }
    const common = commonSubstring(q, t);
    if (common >= 2) return 180 + common;
    const shared = overlap(q, t);
    return shared >= 2 ? 100 + shared : shared === 1 ? 10 : 0;
}

function queryVariants(query: string): SearchVariant[] {
    const whole = searchVariant(query);
    const segments = query.toLocaleLowerCase().match(/\p{Script=Han}+|[a-z0-9]+/gu) ?? [];
    const variants = [whole];
    for (const segment of segments) {
        const variant = searchVariant(segment);
        if (variant.normalized && variant.normalized !== whole.normalized) variants.push(variant);
    }
    return variants;
}

export function rankMemeMatches(index: MemeSearchIndex, query: string, limit = 3): MemeMatch[] {
    const variants = queryVariants(query);
    if (!variants.some((variant) => variant.normalized)) return [];
    return index.items.map(({ entry, index: order, terms }) => {
        let score = 0;
        for (const variant of variants) {
            for (let i = 0; i < terms.length; i++) {
                score = Math.max(score, compare(variant, terms[i], i === 0));
            }
        }
        return { entry, order, score, strength: score >= 400 ? "STRONG" as const : "WEAK" as const };
    }).filter((match) => match.score > 0)
        .sort((a, b) => b.score - a.score || a.order - b.order)
        .slice(0, Math.max(0, Math.min(limit, 3)))
        .map(({ entry, score, strength }) => ({ entry, score, strength }));
}

export function searchMemes(entries: readonly MemeEntry[], query: string, limit = 3): MemeEntry[] {
    return rankMemeMatches(createMemeSearchIndex(entries), query, limit).map(({ entry }) => entry);
}
