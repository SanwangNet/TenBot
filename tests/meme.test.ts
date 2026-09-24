import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { mergeMemeCandidates, serializeMemes } from "../scripts/meme-update-core.js";
import { parseMemeUpdateArgs } from "../scripts/meme-update.js";
import { searchMemes } from "../src/skills/meme/search.js";
import { lookupMeme, memeLookupTool } from "../src/skills/meme/skill.js";
import type { MemeCandidate, MemeEntry } from "../src/skills/meme/types.js";
import { validateMemeCandidate, validateMemeEntry, validateMemeFile } from "../src/skills/meme/validation.js";

const candidate: MemeCandidate = {
    name: "汗流浃背了吧老弟", aliases: ["汗流浃背"], summary: "示例摘要",
    origin: "示例出处", meaning: "示例含义", usage: "示例用法", examples: ["示例句"],
    sources: [{ name: "示例", url: "https://example.com/meme" }],
};
const entry: MemeEntry = { id: "meme-123456789abc", ...candidate,
    firstSeenAt: "2026-01-01", updatedAt: "2026-01-01" };
const dataUrl = new URL("../src/skills/meme/data/memes.json", import.meta.url);

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
test("invalid URL rejected", () => {
    assert.equal(validateMemeCandidate({ ...candidate, sources: [{ name: "bad", url: "file:///tmp/a" }] }), null);
});
test("empty alias cleaned", () => {
    assert.deepEqual(validateMemeCandidate({ ...candidate, aliases: ["", " ", "汗流浃背", "汗流浃背"] })?.aliases, ["汗流浃背"]);
});
test("oversize text rejected", () => assert.equal(validateMemeCandidate({ ...candidate, summary: "a".repeat(241) }), null));
test("entry validation rejects malformed id", () => assert.equal(validateMemeEntry({ ...entry, id: "!" }), null));
test("duplicate name merges and preserves id", () => {
    const result = mergeMemeCandidates([entry], [{ ...candidate, summary: "新摘要" }], "2026-09-24");
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].id, entry.id);
    assert.equal(result.entries[0].firstSeenAt, entry.firstSeenAt);
    assert.equal(result.entries[0].updatedAt, "2026-09-24");
    assert.equal(result.entries[0].summary, "新摘要");
});
test("duplicate alias merges and retains old name", () => {
    const result = mergeMemeCandidates([entry], [{ ...candidate, name: "新叫法", aliases: [entry.aliases[0]] }], "2026-09-24");
    assert.equal(result.entries.length, 1);
    assert.ok(result.entries[0].aliases.includes(entry.name));
});
test("duplicate candidate in same batch merges", () => {
    const result = mergeMemeCandidates([], [candidate, { ...candidate, aliases: ["新别名"] }], "2026-09-24");
    assert.equal(result.entries.length, 1);
    assert.ok(result.entries[0].aliases.includes("新别名"));
});
test("invalid candidate skipped", () => {
    const result = mergeMemeCandidates([], [{ ...candidate, meaning: "" }], "2026-09-24");
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
test("runtime lookup is read-only and misses safely", async () => {
    const before = await readFile(dataUrl, "utf8");
    assert.equal(memeLookupTool.name, "meme_lookup");
    assert.deepEqual(Object.keys(memeLookupTool.parameters.properties), ["query"]);
    assert.equal(lookupMeme('{"query":"不存在的梗"}'), "没有找到本地 Meme 知识。");
    assert.equal(lookupMeme("bad json"), "无效的梗查询。");
    assert.equal(await readFile(dataUrl, "utf8"), before);
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
