import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { buildAiInput } from "../src/ai/input-builder.js";
import { projectMemeCandidates } from "../src/skills/meme/projection.js";
import { buildAutoMemeContext, matchMemesInMessage, AUTO_MEME_TOP_K } from "../src/skills/meme/skill.js";
import type { MemeMatch } from "../src/skills/meme/search.js";
import type { MemeEntry } from "../src/skills/meme/types.js";

const dataUrl = new URL("../src/skills/meme/data/memes.json", import.meta.url);

test("automatic Meme index matches exact names, aliases, and edge punctuation", () => {
    assert.equal(matchMemesInMessage("kskbl")[0]?.name, "kskbl");
    assert.equal(matchMemesInMessage("\u5eb7\u795e\u5f00\u64ad\u4e86")[0]?.name, "kskbl");
    assert.equal(matchMemesInMessage("kskbl\uff1f")[0]?.name, "kskbl");
    assert.deepEqual(matchMemesInMessage(""), []);
});

test("automatic Meme injection is capped at three concise entries", () => {
    const many = matchMemesInMessage("kskbl \u5eb7\u795e\u5f00\u64ad\u4e86 \u96ea\u5c71\u6551\u72d0\u72f8 \u517b\u9f99\u867e SBTI");
    assert.equal(AUTO_MEME_TOP_K, 3);
    assert.ok(many.length <= AUTO_MEME_TOP_K);
    const context = buildAutoMemeContext("kskbl\uff1f");
    assert.match(context, /\u5019\u9009 1: kskbl/);
    assert.match(context, /meaning:/);
    assert.match(context, /\u5339\u914d\u5f3a\u5ea6: strong/);
    assert.match(context, /examples:.*kskbl/);
    assert.doesNotMatch(context, /fullPinyin|pinyinInitials|score:/);
    const input = buildAiInput("A\uff1akskbl\uff1f", "", "", context);
    assert.match(input, /<meme_context>/);
    assert.match(input, /\u5168\u90e8\u5ffd\u7565/);
    assert.match(input, /\u4e0d\u8981\u4e3a\u4e86\u547d\u4e2d\u800c\u5f3a\u884c\u7528\u6897/);
});

test("weak candidates are framed conservatively", () => {
    const context = buildAutoMemeContext("我今天吃饭");
    assert.match(context, /\u5339\u914d\u5f3a\u5ea6: weak/);
    assert.match(context, /\u5f31\u5019\u9009/);
    assert.doesNotMatch(context, /common interactions:/);
});

test("input builder preserves several projected Meme candidates", () => {
    const entry = (id: string): MemeEntry => ({
        id, name: id, aliases: [], summary: `summary ${id}`, origin: `origin ${id}`,
        meaning: `meaning ${id}`, usage: `usage ${id}`, examples: [`example ${id}`],
    });
    const matches: MemeMatch[] = [
        { entry: entry("A"), score: 950, strength: "STRONG" },
        { entry: entry("B"), score: 800, strength: "WEAK" },
        { entry: entry("C"), score: 700, strength: "WEAK" },
    ];
    const input = buildAiInput("chat", "", "", projectMemeCandidates(matches));
    for (const name of ["A", "B", "C"]) assert.match(input, new RegExp(`候选 \\d+: ${name}`));
    assert.match(input, /<meme_context>/);
});

test("zero candidates do not create an empty Meme block", () => {
    const context = buildAutoMemeContext("!!!");
    assert.equal(context, "");
    const input = buildAiInput("chat", "", "", context);
    assert.doesNotMatch(input, /<meme_context>/);
});

test("automatic index is read-only and does not inject the whole data file", async () => {
    const before = await readFile(dataUrl, "utf8");
    const context = buildAutoMemeContext("kskbl\uff1f");
    assert.ok(context.length < before.length);
    assert.equal(await readFile(dataUrl, "utf8"), before);
});
