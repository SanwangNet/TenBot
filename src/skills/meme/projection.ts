import type { MemeMatch } from "./search.js";
import type { MemeEntry } from "./types.js";

/** Project knowledge fields explicitly; runtime search keys and stored ids stay internal. */
export function projectMemeDetail(entry: MemeEntry) {
    return {
        name: entry.name,
        aliases: entry.aliases,
        summary: entry.summary,
        origin: entry.origin,
        meaning: entry.meaning,
        usage: entry.usage,
        examples: entry.examples,
        ...(entry.interactions === undefined ? {} : { interactions: entry.interactions }),
    };
}

export function projectMemeMatches(matches: readonly MemeMatch[], text: string): string {
    if (!matches.length) return "";
    const asksDetail = /出处|来源|怎么来|怎么火|起源|谁先|什么意思|什么梗|怎么用|解释|背景/iu.test(text);
    return matches.map(({ entry, strength }) => {
        if (asksDetail) return [
            `name: ${entry.name}`,
            `confidence: ${strength}`,
            `aliases: ${entry.aliases.slice(0, 4).join("、")}`,
            `summary: ${entry.summary}`,
            `origin: ${entry.origin}`,
            `meaning: ${entry.meaning}`,
            `usage: ${entry.usage}`,
            `examples: ${entry.examples.join(" / ")}`,
            ...(entry.interactions?.length ? ["common interactions:", ...entry.interactions.slice(0, 5).map((item) =>
                `- "${item.input}" → ${item.responses.slice(0, 3).map((response) => `"${response}"`).join(" / ")}`)] : []),
            "guidance: 用户在询问含义或出处，请按问题解释。",
        ].join("\n");
        if (strength === "WEAK") return [
            `name: ${entry.name}`,
            "confidence: WEAK",
            `meaning: ${entry.meaning.slice(0, 80)}`,
            `summary: ${entry.summary.slice(0, 100)}`,
            "guidance: 这只是低置信字符串候选，可能完全无关；不相关就忽略，不要强行玩梗。",
        ].join("\n");
        return [
            `name: ${entry.name}`,
            "confidence: STRONG",
            `summary: ${entry.summary.slice(0, 100)}`,
            `meaning: ${entry.meaning.slice(0, 120)}`,
            `usage: ${entry.usage.slice(0, 120)}`,
            ...(entry.interactions?.length ? ["common interactions:", ...entry.interactions.slice(0, 5).map((item) =>
                `- "${item.input}" → ${item.responses.slice(0, 3).map((response) => `"${response}"`).join(" / ")}`)] : []),
            ...(entry.examples.length ? [`examples: ${entry.examples.slice(0, 2).join(" / ")}`] : []),
            "guidance: 这是高度相关的本地 Meme；如果当前聊天在玩梗，自然参与并参考常见接法，不要默认解释梗本身。",
        ].join("\n");
    }).join("\n\n");
}
