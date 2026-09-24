import { readFileSync } from "node:fs";
import { logger } from "../../shared/logger.js";
import { searchMemes } from "./search.js";
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
