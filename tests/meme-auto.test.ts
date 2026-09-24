import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { buildAiInput } from "../src/ai/input-builder.js";
import { buildAutoMemeContext, matchMemesInMessage } from "../src/skills/meme/skill.js";

const dataUrl = new URL("../src/skills/meme/data/memes.json", import.meta.url);

test("automatic Meme index matches exact names, aliases, and edge punctuation", () => {
    assert.equal(matchMemesInMessage("kskbl")[0]?.name, "kskbl");
    assert.equal(matchMemesInMessage("\u5eb7\u795e\u5f00\u64ad\u4e86")[0]?.name, "kskbl");
    assert.equal(matchMemesInMessage("kskbl\uff1f")[0]?.name, "kskbl");
    assert.deepEqual(matchMemesInMessage("\u4e0d\u5b58\u5728\u7684\u8bcd"), []);
});

test("automatic Meme injection is capped at three concise entries", () => {
    const many = matchMemesInMessage("kskbl \u5eb7\u795e\u5f00\u64ad\u4e86 \u96ea\u5c71\u6551\u72d0\u72f8 \u517b\u9f99\u867e SBTI");
    assert.ok(many.length <= 3);
    const context = buildAutoMemeContext("kskbl\uff1f");
    assert.match(context, /name: kskbl/);
    assert.match(context, /meaning:/);
    assert.match(context, /usage:/);
    assert.doesNotMatch(context, /name: \u7535\u68cdotto/);
    const input = buildAiInput("A\uff1akskbl\uff1f", "", "", context);
    assert.match(input, /<meme_context>/);
    assert.match(input, /\u4e0d\u8981\u4e3a\u540c\u4e00\u6897\u8c03\u7528 meme_lookup \u6216 web_search/);
});

test("automatic index is read-only and does not inject the whole data file", async () => {
    const before = await readFile(dataUrl, "utf8");
    const context = buildAutoMemeContext("kskbl\uff1f");
    assert.ok(context.length < before.length);
    assert.equal(await readFile(dataUrl, "utf8"), before);
});
