import assert from "node:assert/strict";
import { test } from "node:test";
import {
    createMemeSearchIndex, mergeMemeMatchGroups, rankMemeCandidates, rankMemeMatches,
} from "../src/skills/meme/search.js";
import { projectMemeCandidates, projectMemeDetail } from "../src/skills/meme/projection.js";
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

test("automatic candidate merge returns only the top three by score", () => {
    const entries = [meme("A"), meme("B"), meme("C"), meme("D")];
    const matches = entries.map((entry, index) => ({
        entry, score: [0.95, 0.8, 0.7, 0.6][index] * 1000,
        strength: index < 2 ? "STRONG" as const : "WEAK" as const,
    }));
    assert.deepEqual(mergeMemeMatchGroups([{ source: "anchor", matches }], 3).map((item) => item.entry.name),
        ["A", "B", "C"]);
});

test("automatic candidate merge returns fewer than three when only two match", () => {
    const matches = [meme("A"), meme("B")].map((entry, index) => ({
        entry, score: 900 - index * 100, strength: "STRONG" as const,
    }));
    assert.deepEqual(mergeMemeMatchGroups([{ source: "anchor", matches }], 3).map((item) => item.entry.name), ["A", "B"]);
});

test("matches across anchor and new messages deduplicate by id and retain all sources", () => {
    const a = meme("康神开播了", ["kskbl"]);
    const b = meme("Meme B");
    const index = createMemeSearchIndex([a, b]);
    const candidates = rankMemeCandidates(index, [
        { text: "kskbl", source: "anchor" },
        { text: "康神开播了？", source: "new-message" },
    ], 3);
    const target = candidates.find((item) => item.entry.id === a.id);
    assert.ok(target);
    assert.equal(candidates.filter((item) => item.entry.id === a.id).length, 1);
    assert.deepEqual(target.matchedBy, ["anchor", "new-message"]);
});

test("same Meme keeps its highest score across query sources", () => {
    const a = meme("A");
    const merged = mergeMemeMatchGroups([
        { source: "anchor", matches: [{ entry: a, score: 0.71, strength: "WEAK" }] },
        { source: "new-message", matches: [{ entry: a, score: 0.93, strength: "STRONG" }] },
    ], 3);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].score, 0.93);
    assert.equal(merged[0].strength, "STRONG");
    assert.deepEqual(merged[0].matchedBy, ["anchor", "new-message"]);
});

test("same-score candidates have stable name order and strong precedes weak", () => {
    const alpha = meme("Alpha");
    const zulu = meme("Zulu");
    const matches = [
        { entry: alpha, score: 500, strength: "WEAK" as const },
        { entry: zulu, score: 500, strength: "STRONG" as const },
    ];
    for (let run = 0; run < 20; run++) {
        assert.deepEqual(mergeMemeMatchGroups([{ source: "anchor", matches }], 3)
            .map(({ entry }) => entry.name), ["Zulu", "Alpha"]);
    }
    const sameStrength = [
        { entry: zulu, score: 500, strength: "STRONG" as const },
        { entry: alpha, score: 500, strength: "STRONG" as const },
    ];
    assert.deepEqual(mergeMemeMatchGroups([{ source: "anchor", matches: sameStrength }], 3)
        .map(({ entry }) => entry.name), ["Alpha", "Zulu"]);
});

test("strong and weak candidates can coexist in the automatic top three", () => {
    const matches = [
        { entry: meme("A"), score: 900, strength: "STRONG" as const },
        { entry: meme("B"), score: 300, strength: "WEAK" as const },
        { entry: meme("C"), score: 200, strength: "WEAK" as const },
    ];
    assert.deepEqual(mergeMemeMatchGroups([{ source: "anchor", matches }], 3)
        .map(({ entry }) => entry.name), ["A", "B", "C"]);
});

test("strong projection keeps useful fields and hides ids and retrieval metadata", () => {
    const withInteractions = { ...kskbl, interactions: [
        { input: "kskbl？", responses: ["zdjd？"] },
        { input: "zdjd？", responses: ["wkzkbl！"] },
    ] };
    const matches = rankMemeMatches(createMemeSearchIndex([withInteractions]), "kskbl？");
    const context = projectMemeCandidates(matches);
    assert.match(context, /匹配强度: strong/);
    assert.match(context, /summary: 摘要/);
    assert.match(context, /meaning: 含义/);
    assert.match(context, /usage: 用法/);
    assert.match(context, /examples:/);
    assert.match(context, /"kskbl？" → "zdjd？"/);
    assert.doesNotMatch(context, /aliases:|origin:|id:|sources:|fullPinyin|pinyinInitials|score:/);
    assert.deepEqual(kskbl.aliases, []);
});

test("weak projection stays lightweight and omits background and interactions", () => {
    const withInteractions = { ...chovy, interactions: [{ input: "我Chovy", responses: ["接梗"] }] };
    const search = createMemeSearchIndex([withInteractions]);
    const weak = projectMemeCandidates(rankMemeMatches(search, "我今天吃饭"));
    assert.match(weak, /匹配强度: weak/);
    assert.match(weak, /可能相关|字面重合/);
    assert.doesNotMatch(weak, /common interactions:|origin:|examples:|usage:/);
    const strong = projectMemeCandidates(rankMemeMatches(search, "我Chovy是什么意思"));
    assert.match(strong, /summary:/);
    assert.match(strong, /meaning:/);
    assert.match(strong, /usage:/);
});

test("anchor and new-message searches can contribute distinct candidates", () => {
    const anchor = meme("康神开播了");
    const added = meme("真的假的");
    const candidates = rankMemeCandidates(createMemeSearchIndex([anchor, added]), [
        { text: "kskbl", source: "anchor" },
        { text: "真的假的", source: "new-message" },
    ], 3);
    assert.ok(candidates.some((item) => item.entry.id === anchor.id));
    assert.ok(candidates.some((item) => item.entry.id === added.id));
});

test("empty candidates project to an empty context", () => {
    assert.equal(projectMemeCandidates([]), "");
});

test("detailed projection selects knowledge fields without ids or removed metadata", () => {
    const detail = projectMemeDetail({ ...kskbl, interactions: [{ input: "kskbl？", responses: ["zdjd？"] }] });
    assert.deepEqual(Object.keys(detail), ["name", "aliases", "summary", "origin", "meaning", "usage", "examples", "interactions"]);
    assert.deepEqual(detail.interactions, [{ input: "kskbl？", responses: ["zdjd？"] }]);
});
