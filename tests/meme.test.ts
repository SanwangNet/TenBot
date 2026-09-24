import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { mergeMemeCandidates, mergeMemeCandidatesWithinLimit, serializeMemes, writeMemeJson } from "../scripts/meme-update-core.js";
import { buildMemeResearchInstructions, buildMemeResearchSchema, parseMemeUpdateArgs, researchCandidateLimit } from "../scripts/meme-update.js";
import { searchMemes } from "../src/skills/meme/search.js";
import { lookupMeme, memeLookupTool } from "../src/skills/meme/skill.js";
import type { MemeCandidate, MemeEntry } from "../src/skills/meme/types.js";
import { validateMemeCandidate, validateMemeEntry, validateMemeFile } from "../src/skills/meme/validation.js";

const candidate: MemeCandidate = {
    name: "汗流浃背了吧老弟", aliases: ["汗流浃背"], summary: "示例摘要",
    origin: "示例出处", meaning: "示例含义", usage: "示例用法", examples: ["示例句"],
};
const entry: MemeEntry = { id: "meme-123456789abc", ...candidate };
const dataUrl = new URL("../src/skills/meme/data/memes.json", import.meta.url);
const makeCandidate = (index: number): MemeCandidate => ({
    ...candidate,
    name: `测试网络梗 ${index}`,
    aliases: [`梗别名 ${index}`],
});

test("exact name outranks alias", () => {
    const aliasEntry = { ...entry, id: "other-1234", name: "别名条目", aliases: [entry.name] };
    assert.equal(searchMemes([aliasEntry, entry], entry.name)[0].id, entry.id);
});
test("alias lookup", () => assert.equal(searchMemes([entry], "汗流浃背")[0].id, entry.id));
test("normalized case and spacing lookup", () => {
    assert.equal(searchMemes([{ ...entry, aliases: ["Kobe Meme"] }], " kobe  meme ")[0].id, entry.id);
});
test("substring lookup", () => assert.equal(searchMemes([entry], "老弟")[0].id, entry.id));
test("no result", () => assert.deepEqual(searchMemes([entry], "完全无关"), []));
test("at most three results", () => {
    assert.equal(searchMemes(Array.from({ length: 6 }, (_, i) => ({ ...entry, id: `meme-${i}`, name: `测试梗${i}` })), "测试梗").length, 3);
});
test("candidate validation", () => assert.deepEqual(validateMemeCandidate(candidate), candidate));
test("minimal MemeEntry validates without maintenance metadata or interactions", () => {
    assert.deepEqual(validateMemeEntry(entry), entry);
    assert.equal(validateMemeEntry(entry)?.interactions, undefined);
});
test("optional interactions validate, trim, and dedupe without changing old entries", () => {
    assert.equal(validateMemeEntry(entry)?.interactions, undefined);
    assert.deepEqual(validateMemeEntry({ ...entry, interactions: [] })?.interactions, []);
    const interaction = { input: " kskbl？ ", responses: [" zdjd？ ", "zdjd？"] };
    assert.deepEqual(validateMemeEntry({ ...entry, interactions: [interaction] })?.interactions,
        [{ input: "kskbl？", responses: ["zdjd？"] }]);
    for (const invalid of [
        [{ input: " ", responses: ["zdjd？"] }],
        [{ input: "kskbl？", responses: [] }],
        [{ input: "kskbl？", responses: [" "] }],
        [{ input: "x".repeat(161), responses: ["zdjd？"] }],
        [{ input: "kskbl？", responses: ["x".repeat(161)] }],
        [{ input: "kskbl？", responses: Array(6).fill("zdjd？") }],
        Array(11).fill({ input: "kskbl？", responses: ["zdjd？"] }),
    ]) assert.equal(validateMemeEntry({ ...entry, interactions: invalid }), null);
});
test("current Meme knowledge validates without removed metadata", async () => {
    const data = JSON.parse(await readFile(dataUrl, "utf8"));
    assert.equal(validateMemeFile(data).length, data.length);
    assert.equal(data.some((item: Record<string, unknown>) =>
        "sources" in item || "firstSeenAt" in item || "updatedAt" in item), false);
});
test("empty alias cleaned", () => {
    assert.deepEqual(validateMemeCandidate({ ...candidate, aliases: ["", " ", "汗流浃背", "汗流浃背"] })?.aliases, ["汗流浃背"]);
});
test("oversize text rejected", () => assert.equal(validateMemeCandidate({ ...candidate, summary: "a".repeat(241) }), null));
test("entry validation rejects malformed id", () => assert.equal(validateMemeEntry({ ...entry, id: "!" }), null));
test("duplicate name merges and preserves id", () => {
    const result = mergeMemeCandidates([entry], [{ ...candidate, summary: "新摘要" }]);
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].id, entry.id);
    assert.equal(result.entries[0].summary, "新摘要");
});
test("updating a Meme without interactions preserves its existing behavior examples", () => {
    const existing = { ...entry, interactions: [{ input: "kskbl？", responses: ["zdjd？"] }] };
    const merged = mergeMemeCandidates([existing], [{ ...candidate, summary: "新摘要" }]);
    assert.deepEqual(merged.entries[0].interactions, existing.interactions);
});
test("duplicate alias merges and retains old name", () => {
    const result = mergeMemeCandidates([entry], [{ ...candidate, name: "新叫法", aliases: [entry.aliases[0]] }]);
    assert.equal(result.entries.length, 1);
    assert.ok(result.entries[0].aliases.includes(entry.name));
});
test("duplicate candidate in same batch merges", () => {
    const result = mergeMemeCandidates([], [candidate, { ...candidate, aliases: ["新别名"] }]);
    assert.equal(result.entries.length, 1);
    assert.ok(result.entries[0].aliases.includes("新别名"));
});
test("invalid candidate skipped", () => {
    const result = mergeMemeCandidates([], [{ ...candidate, meaning: "" }]);
    assert.equal(result.entries.length, 0);
    assert.equal(result.skipped.length, 1);
});
test("deterministic JSON output", () => {
    const second = { ...entry, id: "abc-1234", name: "另一个", aliases: ["第二别名"] };
    assert.equal(serializeMemes([entry, second]), serializeMemes([second, entry]));
    assert.match(serializeMemes([entry]), /\n    "id":/);
});
test("duplicate stored id rejected", () => assert.throws(() => validateMemeFile([entry, entry])));
test("duplicate stored alias across entries rejected", () => {
    assert.throws(() => validateMemeFile([entry, { ...entry, id: "other-1234", name: "别名", aliases: [entry.name] }]));
});
test("CLI parses topic, limit, dry run", () => {
    assert.deepEqual(parseMemeUpdateArgs(["--limit", "5", "--dry-run", "汗流浃背了吧老弟"]),
        { limit: 5, topic: "汗流浃背了吧老弟", dryRun: true });
    assert.throws(() => parseMemeUpdateArgs(["--limit", "11"]));
});
test("default candidate limit retains exactly eight", () => {
    const result = mergeMemeCandidatesWithinLimit([], Array.from({ length: 8 }, (_, i) => makeCandidate(i)), 8);
    assert.equal(result.accepted.length, 8);
    assert.equal(result.merge.added.length, 8);
});
test("excess candidates are truncated instead of failing", () => {
    const nine = mergeMemeCandidatesWithinLimit([], Array.from({ length: 9 }, (_, i) => makeCandidate(i)), 8);
    const twenty = mergeMemeCandidatesWithinLimit([], Array.from({ length: 20 }, (_, i) => makeCandidate(i)), 8);
    assert.equal(nine.accepted.length, 8);
    assert.equal(nine.merge.added.length, 8);
    assert.equal(twenty.accepted.length, 8);
});
test("fewer candidates than the limit are all retained", () => {
    assert.equal(mergeMemeCandidatesWithinLimit([], [makeCandidate(1), makeCandidate(2)], 8).accepted.length, 2);
});
test("invalid entries are filtered before the final limit", () => {
    const raw = [{ ...makeCandidate(99), usage: "" }, { ...makeCandidate(98), name: "" },
        ...Array.from({ length: 8 }, (_, i) => makeCandidate(i))];
    const result = mergeMemeCandidatesWithinLimit([], raw, 8);
    assert.equal(result.accepted.length, 8);
    assert.equal(result.prepared.skipped.length, 2);
});
test("duplicate candidates are removed before consuming limit slots", () => {
    const unique = Array.from({ length: 8 }, (_, i) => makeCandidate(i));
    const result = mergeMemeCandidatesWithinLimit([], [...unique, { ...unique[0], summary: "重复" }], 8);
    assert.equal(result.accepted.length, 8);
    assert.equal(result.merge.entries.length, 8);
});
test("limit five caps seven valid unique candidates and still merges", () => {
    const result = mergeMemeCandidatesWithinLimit([], Array.from({ length: 7 }, (_, i) => makeCandidate(i)), 5);
    assert.equal(result.accepted.length, 5);
    assert.equal(result.merge.added.length, 5);
    assert.equal(researchCandidateLimit(5), 5);
});
test("research prompt and strict schema use the dynamic candidate limit", () => {
    const schema = buildMemeResearchSchema(5) as { properties: { memes: { maxItems: number } } };
    assert.equal(schema.properties.memes.maxItems, 5);
    assert.match(buildMemeResearchInstructions(5), /最多返回 5 个/);
    assert.equal((buildMemeResearchSchema(8, "指定梗") as { properties: { memes: { maxItems: number } } }).properties.memes.maxItems, 1);
    assert.equal(researchCandidateLimit(8, "指定梗"), 1);
});
test("dry run truncates excess and never invokes the writer", async () => {
    const result = mergeMemeCandidatesWithinLimit([], Array.from({ length: 9 }, (_, i) => makeCandidate(i)), 8);
    let writes = 0;
    const wrote = await writeMemeJson(serializeMemes(result.merge.entries), true, "[]\n", async () => { writes++; });
    assert.equal(result.accepted.length, 8);
    assert.equal(wrote, false);
    assert.equal(writes, 0);
});
test("regular update truncates excess and writes merged entries", async () => {
    const result = mergeMemeCandidatesWithinLimit([], Array.from({ length: 9 }, (_, i) => makeCandidate(i)), 8);
    let written = "";
    const wrote = await writeMemeJson(serializeMemes(result.merge.entries), false, "[]\n", async (content) => { written = content; });
    assert.equal(result.merge.added.length, 8);
    assert.equal(wrote, true);
    assert.equal(JSON.parse(written).length, 8);
});
test("runtime lookup is read-only and misses safely", async () => {
    const before = await readFile(dataUrl, "utf8");
    assert.equal(memeLookupTool.name, "meme_lookup");
    assert.deepEqual(Object.keys(memeLookupTool.parameters.properties), ["query"]);
    assert.equal(lookupMeme('{"query":"不存在的梗"}'), "没有找到本地 Meme 知识。");
    assert.equal(lookupMeme("bad json"), "无效的梗查询。");
    assert.equal(await readFile(dataUrl, "utf8"), before);
});
test("meme_lookup returns detailed knowledge without ids or removed metadata", () => {
    const result = JSON.parse(lookupMeme('{"query":"kskbl"}')) as Record<string, unknown>[];
    assert.ok(result.length > 0);
    assert.deepEqual(Object.keys(result[0]),
        ["confidence", "name", "aliases", "summary", "origin", "meaning", "usage", "examples"]);
});
test("runtime dependency graph excludes maintenance script", async () => {
    const client = await readFile(new URL("../src/ai/client.ts", import.meta.url), "utf8");
    const skill = await readFile(new URL("../src/skills/meme/skill.ts", import.meta.url), "utf8");
    assert.doesNotMatch(client + skill, /scripts\/|meme-update/);
});
test("offline meme_lookup call continues to final reply", async () => {
    const dataBefore = await readFile(dataUrl, "utf8");
    process.env.CODEX_API_KEY = "offline-test";
    process.env.CODEX_BASE_URL = "https://example.invalid";
    const { chat } = await import("../src/ai/client.js");
    const completed = (output: unknown[]) => ({ type: "response.completed", response: { output } });
    const streams = [
        [completed([{ type: "function_call", id: "fc_1", call_id: "call_1", name: "meme_lookup", arguments: '{"query":"未知梗"}' }])],
        [completed([{ type: "message", content: [{ type: "output_text", text: "我还不确定这个梗的意思。", annotations: [] }] }])],
    ];
    const requests: unknown[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_request, init) => {
        requests.push(JSON.parse(String(init?.body)));
        const events = streams.shift();
        if (!events) throw new Error("Unexpected offline AI call");
        return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
            { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    try {
        const result = await chat("未知梗是什么意思", { signal: new AbortController().signal });
        assert.equal(result.kind, "reply");
        if (result.kind === "reply") assert.deepEqual(result.action.messages, ["我还不确定这个梗的意思。"]);
        assert.equal(requests.length, 2);
        const second = requests[1] as { input: Array<{ type?: string; call_id?: string; output?: string }> };
        assert.deepEqual(second.input.find((item) => item.type === "function_call_output"), {
            type: "function_call_output", call_id: "call_1", output: "没有找到本地 Meme 知识。",
        });
        assert.equal(await readFile(dataUrl, "utf8"), dataBefore);
    } finally { globalThis.fetch = originalFetch; }
});
