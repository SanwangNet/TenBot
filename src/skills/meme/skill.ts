import { readFileSync } from "node:fs";
import { logger } from "../../shared/logger.js";
import { normalizeMemeTerm, searchMemes } from "./search.js";
import { validateMemeFile } from "./validation.js";

const entries = validateMemeFile(JSON.parse(readFileSync(new URL("./data/memes.json", import.meta.url), "utf8")));

export const memeLookupTool = {
    type: "function" as const,
    name: "meme_lookup",
    description: "只读查询本地网络梗知识。用户询问某梗的含义、出处、用法，或一句话可能有特定网络语境且你不确定时调用。已经有把握时无需调用；结果只供理解，由你自然决定如何回复。查不到时可按需使用 web_search 现场回答，但不能把现场结果写入知识库。",
    strict: true,
    parameters: {
        type: "object",
        properties: { query: { type: "string", description: "梗名或常见别名" } },
        required: ["query"],
        additionalProperties: false,
    },
};


const autoIndex = new Map<string, { entry: (typeof entries)[number]; exact: boolean }>();
for (const entry of entries) {
    for (const term of [entry.name, ...entry.aliases]) {
        const key = normalizeAutoTerm(term);
        if (key && isSafeAutoTerm(key)) autoIndex.set(key, { entry, exact: true });
    }
}

function normalizeAutoTerm(value: string): string {
    return normalizeMemeTerm(value).replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "");
}

function isSafeAutoTerm(value: string): boolean {
    const han = value.match(/\p{Script=Han}/gu)?.length ?? 0;
    const latinOrDigits = value.match(/[a-z0-9]/gi)?.length ?? 0;
    return han >= 2 || latinOrDigits >= 4 || value.length >= 4;
}

export function matchMemesInMessage(text: string, limit = 3): (typeof entries)[number][] {
    const normalized = normalizeAutoTerm(text);
    if (!normalized) return [];
    const exact = autoIndex.get(normalized);
    const matches: Array<{ entry: (typeof entries)[number]; score: number; length: number }> = [];
    if (exact) matches.push({ entry: exact.entry, score: 2, length: normalized.length });
    for (const [term, indexed] of autoIndex) {
        if (term === normalized || !normalized.includes(term)) continue;
        matches.push({ entry: indexed.entry, score: 1, length: term.length });
    }
    const seen = new Set<string>();
    return matches
        .sort((a, b) => b.score - a.score || b.length - a.length)
        .filter(({ entry }) => !seen.has(entry.id) && Boolean(seen.add(entry.id)))
        .slice(0, Math.min(3, Math.max(0, limit)))
        .map(({ entry }) => entry);
}

export function buildAutoMemeContext(text: string): string {
    const matches = matchMemesInMessage(text);
    if (!matches.length) return "";
    const asksOrigin = /\u51fa\u5904|\u6765\u6e90|\u600e\u4e48\u6765|\u600e\u4e48\u706b|\u8d77\u6e90|\u8c01\u5148/iu.test(text);
    return matches.map((entry) => [
        "name: " + entry.name,
        "aliases: " + entry.aliases.join("、"),
        "summary: " + entry.summary,
        "meaning: " + entry.meaning,
        "usage: " + entry.usage,
        ...(asksOrigin ? ["origin: " + entry.origin, "sources: " + entry.sources.map((source) => source.url).join(" ")] : []),
    ].join("\n")).join("\n\n");
}

export function lookupMeme(argumentsJson: string): string {
    let query: unknown;
    try { query = (JSON.parse(argumentsJson) as { query?: unknown }).query; } catch { /* invalid call */ }
    if (typeof query !== "string" || query.trim().length === 0 || query.length > 100) {
        return "无效的梗查询。";
    }
    logger.debug(`[Skill:meme] lookup ${JSON.stringify(query)}`);
    const matches = searchMemes(entries, query);
    logger.debug(`[Skill:meme] hit ${matches.length}`);
    if (!matches.length) return "没有找到本地 Meme 知识。";
    return JSON.stringify(matches.map(({ name, aliases, summary, origin, meaning, usage, sources }) =>
        ({ name, aliases, summary, origin, meaning, usage, sources })));
}
