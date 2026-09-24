import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemeSearchIndex, rankMemeMatches } from "../src/skills/meme/search.js";
import { projectMemeDetail, projectMemeMatches } from "../src/skills/meme/projection.js";
import type { MemeEntry } from "../src/skills/meme/types.js";

function meme(name: string, aliases: string[] = []): MemeEntry {
    return { id: name, name, aliases, summary: "摘要", origin: "出处", meaning: "含义", usage: "用法",
        examples: ["A：提问", "B：接梗"] };
}

const kskbl = meme("康神开播了"); // Intentionally no handwritten "kskbl" alias.
const chovy = meme("我Chovy");
const index = createMemeSearchIndex([chovy, kskbl]);
const top = (query: string) => rankMemeMatches(index, query)[0];

test("derived initials recall a Chinese meme without an alias, regardless of case", () => {
    for (const query of ["kskbl？", "KSKBL", "KsKbL"]) {
        assert.equal(top(query)?.entry.name, "康神开播了");
        assert.equal(top(query)?.strength, "STRONG");
    }
    assert.deepEqual(kskbl.aliases, []);
});

test("full and partial pinyin, Chinese exact and Chinese prefix rank by specificity", () => {
    const full = top("kangshenkaibole");
    const partial = top("kangshenkai");
    const chinese = top("康神开播了？");
    const chinesePrefix = top("康神开播");
    for (const match of [full, partial, chinese, chinesePrefix]) {
        assert.equal(match?.entry.name, "康神开播了");
        assert.equal(match?.strength, "STRONG");
    }
    assert.ok(full.score > partial.score);
    assert.ok(chinese.score > chinesePrefix.score);
});

test("initial prefix and subsequence recall below exact initials", () => {
    const exact = top("kskbl");
    const prefix = top("kskb");
    const subsequence = top("kskl");
    assert.equal(prefix.entry.name, "康神开播了");
    assert.equal(subsequence.entry.name, "康神开播了");
    assert.ok(exact.score > prefix.score && prefix.score > subsequence.score);
});

test("mixed Han and Latin spellings match, with weak one-character overlap kept below a strong hit", () => {
    for (const query of ["我Chovy", "我chovy", "wochovy"]) {
        assert.equal(top(query)?.entry.name, "我Chovy");
        assert.equal(top(query)?.strength, "STRONG");
    }
    const weak = rankMemeMatches(index, "我今天吃饭").find((match) => match.entry.name === "我Chovy");
    assert.equal(weak?.strength, "WEAK");
    const ranked = rankMemeMatches(index, "kskbl 我今天吃饭");
    assert.equal(ranked[0]?.entry.name, "康神开播了");
    assert.ok(ranked[0].score > (ranked.find((match) => match.entry.name === "我Chovy")?.score ?? 0));
    assert.equal(top("康神kbl")?.entry.name, "康神开播了");
    const bamboo = createMemeSearchIndex([meme("竹知了")]);
    assert.equal(rankMemeMatches(bamboo, "竹zl")[0]?.entry.name, "竹知了");
});

test("runtime search keys do not mutate entries or aliases", () => {
    assert.deepEqual(kskbl.aliases, []);
    assert.equal(JSON.stringify(kskbl).includes("kangshenkaibole"), false);
    assert.equal(JSON.stringify(kskbl).includes("kskbl"), false);
});

test("strong projection prioritizes interactions and natural participation without derived keys", () => {
    const withInteractions = { ...kskbl, interactions: [
        { input: "kskbl？", responses: ["zdjd？"] },
        { input: "zdjd？", responses: ["wkzkbl！"] },
    ] };
    const matches = rankMemeMatches(createMemeSearchIndex([withInteractions]), "kskbl？");
    const context = projectMemeMatches(matches, "kskbl？");
    assert.match(context, /confidence: STRONG/);
    assert.match(context, /"kskbl？" → "zdjd？"/);
    assert.match(context, /自然参与/);
    assert.doesNotMatch(context, /aliases:|origin:|id:|sources:|fullPinyin|pinyinInitials|score:/);
    assert.deepEqual(kskbl.aliases, []);
});

test("weak projection stays cautious and omits interactions; explanation intent includes origin", () => {
    const withInteractions = { ...chovy, interactions: [{ input: "我Chovy", responses: ["接梗"] }] };
    const search = createMemeSearchIndex([withInteractions]);
    const weak = projectMemeMatches(rankMemeMatches(search, "我今天吃饭"), "我今天吃饭");
    assert.match(weak, /confidence: WEAK/);
    assert.match(weak, /可能完全无关/);
    assert.doesNotMatch(weak, /common interactions:/);
    const strong = projectMemeMatches(rankMemeMatches(search, "我Chovy是什么意思"), "我Chovy是什么意思");
    assert.match(strong, /summary:/);
    assert.match(strong, /origin:/);
    assert.match(strong, /请按问题解释/);
});

test("detailed projection selects knowledge fields without ids or removed metadata", () => {
    const detail = projectMemeDetail({ ...kskbl, interactions: [{ input: "kskbl？", responses: ["zdjd？"] }] });
    assert.deepEqual(Object.keys(detail), ["name", "aliases", "summary", "origin", "meaning", "usage", "examples", "interactions"]);
    assert.deepEqual(detail.interactions, [{ input: "kskbl？", responses: ["zdjd？"] }]);
});
