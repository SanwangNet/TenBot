import { createHash } from "node:crypto";
import { normalizeMemeTerm } from "../src/skills/meme/search.js";
import type { MemeCandidate, MemeEntry } from "../src/skills/meme/types.js";
import { validateMemeCandidate, validateMemeFile } from "../src/skills/meme/validation.js";

export interface MergeResult {
    entries: MemeEntry[];
    added: string[];
    updated: string[];
    skipped: string[];
}

export interface PreparedMemeCandidates {
    candidates: MemeCandidate[];
    skipped: string[];
}

/** Validate and deduplicate before applying the candidate cap, so bad or repeated items don't use slots. */
export function prepareMemeCandidates(rawCandidates: readonly unknown[]): PreparedMemeCandidates {
    const result = mergeMemeCandidates([], rawCandidates);
    return {
        candidates: result.entries.map(({ name, aliases, summary, origin, meaning, usage, examples, interactions }) =>
            ({ name, aliases, summary, origin, meaning, usage, examples,
                ...(interactions === undefined ? {} : { interactions }) })),
        skipped: result.skipped,
    };
}

export function truncateMemeCandidates(candidates: readonly MemeCandidate[], limit: number): MemeCandidate[] {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Invalid candidate limit");
    return [...candidates].slice(0, limit);
}

export function mergeMemeCandidatesWithinLimit(
    existing: readonly MemeEntry[],
    rawCandidates: readonly unknown[],
    limit: number,
): { received: number; prepared: PreparedMemeCandidates; accepted: MemeCandidate[]; merge: MergeResult } {
    const prepared = prepareMemeCandidates(rawCandidates);
    const accepted = truncateMemeCandidates(prepared.candidates, limit);
    return {
        received: rawCandidates.length,
        prepared,
        accepted,
        merge: mergeMemeCandidates(existing, accepted),
    };
}

export async function writeMemeJson(
    output: string,
    dryRun: boolean,
    current: string,
    write: (content: string) => Promise<void>,
): Promise<boolean> {
    if (dryRun || output === current) return false;
    await write(output);
    return true;
}

export function mergeMemeCandidates(existing: readonly MemeEntry[], rawCandidates: readonly unknown[]): MergeResult {
    const entries = [...existing];
    const result: MergeResult = { entries, added: [], updated: [], skipped: [] };
    for (const [index, raw] of rawCandidates.entries()) {
        const candidate = validateMemeCandidate(raw);
        if (!candidate) {
            result.skipped.push(`candidate ${index + 1}: invalid`);
            continue;
        }
        const terms = new Set([candidate.name, ...candidate.aliases].map(normalizeMemeTerm));
        const matches = entries.filter((entry) => {
            const rawId = raw && typeof raw === "object" && "id" in raw ? (raw as { id?: unknown }).id : undefined;
            return rawId === entry.id || [entry.name, ...entry.aliases].some((term) => terms.has(normalizeMemeTerm(term)));
        });
        if (matches.length > 1) {
            result.skipped.push(`${candidate.name}: ambiguous duplicate`);
            continue;
        }
        if (matches.length) {
            const old = matches[0];
            const merged: MemeEntry = {
                ...candidate,
                ...(candidate.interactions === undefined && old.interactions !== undefined
                    ? { interactions: old.interactions } : {}),
                id: old.id,
                aliases: [...new Set([...old.aliases, old.name, ...candidate.aliases])]
                    .filter((alias) => alias !== candidate.name)
                    .sort((a, b) => a.localeCompare(b, "zh-CN")),
            };
            const position = entries.indexOf(old);
            entries[position] = merged;
            result.updated.push(candidate.name);
        } else {
            const id = stableMemeId(candidate);
            if (entries.some((entry) => entry.id === id)) {
                result.skipped.push(`${candidate.name}: id collision`);
                continue;
            }
            entries.push({ id, ...candidate });
            result.added.push(candidate.name);
        }
    }
    return result;
}

function stableMemeId(candidate: MemeCandidate): string {
    const normalized = normalizeMemeTerm(candidate.name);
    const ascii = normalized.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
    const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 12);
    return `${ascii || "meme"}-${hash}`;
}

export function serializeMemes(entries: readonly MemeEntry[]): string {
    const valid = validateMemeFile(entries);
    return JSON.stringify([...valid].sort((a, b) => a.id.localeCompare(b.id)), null, 2) + "\n";
}
