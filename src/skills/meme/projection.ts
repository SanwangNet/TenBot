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

/** Keep automatic candidates concise and never expose search/debug metadata. */
export function projectMemeCandidates(matches: readonly MemeMatch[]): string {
    if (!matches.length) return "";
    const candidates = matches.map(({ entry, strength }, index) => {
        const heading = [
            `\u5019\u9009 ${index + 1}: ${entry.name}`,
            `\u5339\u914d\u5f3a\u5ea6: ${strength === "STRONG" ? "strong" : "weak"}`,
        ];
        if (strength === "WEAK") return [
            ...heading,
            `summary: ${entry.summary.slice(0, 100)}`,
            `meaning: ${entry.meaning.slice(0, 80)}`,
            "\u8fd9\u53ea\u662f\u53ef\u80fd\u76f8\u5173\u7684\u5f31\u5019\u9009\uff0c\u4e5f\u53ef\u80fd\u53ea\u662f\u5b57\u9762\u91cd\u5408\uff0c\u4e0d\u76f8\u5173\u65f6\u53ef\u5ffd\u7565\u3002",
        ].join("\n");
        return [
            ...heading,
            `summary: ${entry.summary.slice(0, 100)}`,
            `meaning: ${entry.meaning.slice(0, 120)}`,
            `usage: ${entry.usage.slice(0, 120)}`,
            ...(entry.examples.length ? [`examples: ${entry.examples.slice(0, 2).join(" / ")}`] : []),
            ...(entry.interactions?.length ? [
                "common interactions:",
                ...entry.interactions.slice(0, 5).map((item) =>
                    `- "${item.input}" \u2192 ${item.responses.slice(0, 3).map((response) => `"${response}"`).join(" / ")}`),
            ] : []),
        ].join("\n");
    });
    return candidates.join("\n\n");
}
