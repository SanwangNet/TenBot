import "dotenv/config";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import OpenAI from "openai";
import { mergeMemeCandidates, serializeMemes } from "./meme-update-core.js";
import { validateMemeFile } from "../src/skills/meme/validation.js";

const dataUrl = new URL("../src/skills/meme/data/memes.json", import.meta.url);
const MODEL = "gpt-6-sol";

export function parseMemeUpdateArgs(args: string[]): { limit: number; topic?: string; dryRun: boolean } {
    let limit = 8;
    let dryRun = false;
    const topicParts: string[] = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--dry-run") dryRun = true;
        else if (arg === "--limit") {
            const value = args[++i];
            if (!value || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 10) {
                throw new Error("--limit must be an integer from 1 to 10");
            }
            limit = Number(value);
        } else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
        else topicParts.push(arg);
    }
    const topic = topicParts.join(" ").trim();
    if (topic.length > 100) throw new Error("Meme topic is too long");
    return { limit, topic: topic || undefined, dryRun };
}

const sourceSchema = {
    type: "object", additionalProperties: false,
    properties: { name: { type: "string" }, url: { type: "string" } },
    required: ["name", "url"],
};
const memeSchema = {
    type: "object", additionalProperties: false,
    properties: {
        name: { type: "string" }, aliases: { type: "array", items: { type: "string" } },
        summary: { type: "string" }, origin: { type: "string" }, meaning: { type: "string" },
        usage: { type: "string" }, examples: { type: "array", items: { type: "string" } },
        sources: { type: "array", items: sourceSchema },
    },
    required: ["name", "aliases", "summary", "origin", "meaning", "usage", "examples", "sources"],
};

async function main(): Promise<void> {
    const { limit, topic, dryRun } = parseMemeUpdateArgs(process.argv.slice(2));
    const apiKey = process.env.CODEX_API_KEY;
    const baseURL = process.env.CODEX_BASE_URL;
    if (!apiKey || !baseURL) throw new Error("缺少 CODEX_API_KEY 或 CODEX_BASE_URL");
    const existing = validateMemeFile(JSON.parse(await readFile(dataUrl, "utf8")));
    console.log(`[Meme] researching ${topic ? JSON.stringify(topic) : "current Chinese memes"}...`);
    const client = new OpenAI({ apiKey, baseURL });
    const response = await client.responses.create({
        model: MODEL,
        instructions: [
            "你是网络梗资料整理员。必须使用 web_search 核查真实来源，然后用自己的话返回简短中文结构化摘要，不复制文章或评论长段落。",
            "关注近期在中国大陆社交平台、游戏、二次元及技术社区有明显传播的梗；海外梗仅在中文社区传播时收录。不要编造热度排名。",
            "尽量交叉确认出处，优先原始内容；有争议就明确写不确定。解释含义、传播背景、常见用法、语气、反讽或误用风险，少量短例子。每条至少一个可访问的 HTTP(S) 来源链接。",
            "跳过未证实、过气且无近期使用价值、隐私泄露、针对普通个人的网暴、极端暴力鼓动及违法操作教程。",
            topic ? "仅研究用户指定的一个梗，勿返回其他梗。" : `最多返回 ${limit} 个值得认识的梗。`,
        ].join("\n"),
        input: topic ? `深入研究这个梗：${topic}` : `寻找近期值得认识的中文网络梗，最多 ${limit} 个。`,
        tools: [{ type: "web_search" }],
        tool_choice: "required",
        text: { format: { type: "json_schema", name: "meme_research", strict: true,
            schema: { type: "object", additionalProperties: false,
                properties: { memes: { type: "array", items: memeSchema } }, required: ["memes"] } } },
        store: false,
    }, { maxRetries: 0 });
    if (!response.output.some((item) => item.type === "web_search_call")) {
        throw new Error("Research response did not use web_search; knowledge file unchanged");
    }
    if (response.status !== "completed") throw new Error(`Research response status: ${response.status}`);
    const parsed: unknown = JSON.parse(response.output_text);
    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { memes?: unknown }).memes)) {
        throw new Error("Invalid structured research result");
    }
    const candidates = (parsed as { memes: unknown[] }).memes;
    if (candidates.length > (topic ? 1 : limit)) throw new Error("Research returned too many candidates");
    const result = mergeMemeCandidates(existing, candidates, new Date().toISOString().slice(0, 10));
    for (const name of result.added) console.log(`[Meme] added ${name}`);
    for (const name of result.updated) console.log(`[Meme] updated ${name}`);
    for (const reason of result.skipped) console.log(`[Meme] skipped ${reason}`);
    const output = serializeMemes(result.entries);
    if (!dryRun && output !== await readFile(dataUrl, "utf8")) await writeFile(dataUrl, output, "utf8");
    console.log(`[Meme] ${dryRun ? "dry run" : "saved"} ${result.entries.length} entries`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
    main().catch((error: unknown) => {
        console.error("[Meme] update failed:", error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
