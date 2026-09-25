import { readFileSync } from "node:fs";
import { logger } from "../../shared/logger.js";
import {
    createMemeSearchIndex, rankMemeCandidates, rankMemeMatches, type MemeMatch, type MemeSearchQuery,
} from "./search.js";
import { projectMemeCandidates, projectMemeDetail } from "./projection.js";
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


const runtimeIndex = createMemeSearchIndex(entries);
export const AUTO_MEME_TOP_K = 3;

export function searchAutoMemeCandidates(
    queries: readonly MemeSearchQuery[],
    limit = AUTO_MEME_TOP_K,
): MemeMatch[] {
    return rankMemeCandidates(runtimeIndex, queries, Math.min(limit, AUTO_MEME_TOP_K));
}

export function matchMemesInMessage(text: string, limit = AUTO_MEME_TOP_K): (typeof entries)[number][] {
    return searchAutoMemeCandidates([{ text, source: "anchor" }], limit).map(({ entry }) => entry);
}

export function buildAutoMemeContext(input: string | readonly MemeSearchQuery[]): string {
    const queries = typeof input === "string" ? [{ text: input, source: "anchor" as const }] : input;
    return projectMemeCandidates(searchAutoMemeCandidates(queries));
}

export function lookupMeme(argumentsJson: string): string {
    let query: unknown;
    try { query = (JSON.parse(argumentsJson) as { query?: unknown }).query; } catch { /* invalid call */ }
    if (typeof query !== "string" || query.trim().length === 0 || query.length > 100) {
        return "无效的梗查询。";
    }
    logger.debug(`[Skill:meme] lookup ${JSON.stringify(query)}`);
    const matches = rankMemeMatches(runtimeIndex, query).filter((match) => match.score >= 180);
    logger.debug(`[Skill:meme] hit ${matches.length}`);
    if (!matches.length) return "没有找到本地 Meme 知识。";
    return JSON.stringify(matches.map(({ entry, strength }) =>
        ({ confidence: strength, ...projectMemeDetail(entry) })));
}
