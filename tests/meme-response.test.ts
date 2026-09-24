import assert from "node:assert/strict";
import test from "node:test";
import OpenAI from "openai";
import { formatMemeUpdateError } from "../scripts/meme-update.js";
import {
    normalizeResponsesResponse, parseMemeResearchResponse, responseDiagnostics,
} from "../scripts/meme-response.js";

const meme = {
    name: "测试梗", aliases: [], summary: "测试摘要", origin: "测试出处",
    meaning: "测试含义", usage: "测试用法", examples: [],
};
const research = { memes: [meme] };
const fixture = {
    id: "resp_test", object: "response", status: "completed",
    output: [
        { type: "reasoning", content: [], encrypted_content: "SECRET_ENCRYPTED_REASONING" },
        { type: "web_search_call", status: "completed", action: { query: "NOT_MEME_DATA" } },
        { type: "message", status: "completed", role: "assistant",
            content: [{ type: "output_text", text: JSON.stringify(research) }] },
    ],
};

test("standard Responses object extracts final structured meme research", () => {
    assert.deepEqual(parseMemeResearchResponse(fixture), research);
});
test("one stringified Responses object extracts the same research", () => {
    assert.deepEqual(parseMemeResearchResponse(JSON.stringify(fixture)), research);
});
test("top-level output_text takes precedence over message content", () => {
    assert.deepEqual(parseMemeResearchResponse({ ...fixture, output_text: JSON.stringify({ memes: [] }) }), { memes: [] });
});
test("missing SDK output_text falls back to final assistant message", () => {
    assert.deepEqual(parseMemeResearchResponse({ ...fixture, output_text: "" }), research);
});
test("reasoning and web_search items are ignored as output data", () => {
    const parsed = parseMemeResearchResponse(fixture);
    assert.deepEqual(parsed.memes, [meme]);
    assert.doesNotMatch(JSON.stringify(parsed), /SECRET_ENCRYPTED_REASONING|NOT_MEME_DATA/);
});
test("already parsed structured payload is accepted", () => {
    assert.deepEqual(parseMemeResearchResponse({ ...fixture, output_text: research }), research);
    const output = fixture.output.map((item) => item.type === "message"
        ? { ...item, content: [{ type: "output_text", text: research }] } : item);
    assert.deepEqual(parseMemeResearchResponse({ ...fixture, output }), research);
});
test("invalid top-level JSON string fails clearly", () => {
    assert.throws(() => normalizeResponsesResponse("not JSON"), /invalid Responses payload: JSON parse failed/);
});
test("a second JSON-encoded string is not parsed recursively", () => {
    assert.throws(() => normalizeResponsesResponse(JSON.stringify(JSON.stringify(fixture))), /expected object, got string/);
});
test("top-level primitives and null fail without an in-operator TypeError", () => {
    for (const value of [42, null, true, undefined]) {
        assert.throws(() => parseMemeResearchResponse(value), /invalid Responses payload: expected object/);
    }
});
test("completed response without final assistant message fails clearly", () => {
    assert.throws(() => parseMemeResearchResponse({ ...fixture, output: fixture.output.slice(0, 2) }),
        /no final assistant output_text/);
});
test("earlier assistant text is not used when the final assistant message has no output_text", () => {
    const earlier = fixture.output[2];
    const final = { type: "message", role: "assistant", status: "completed", content: [] };
    assert.throws(() => parseMemeResearchResponse({ ...fixture, output: [...fixture.output, earlier, final] }),
        /no final assistant output_text/);
});
test("invalid final output_text JSON fails clearly", () => {
    const output = fixture.output.map((item) => item.type === "message"
        ? { ...item, content: [{ type: "output_text", text: "{bad" }] } : item);
    assert.throws(() => parseMemeResearchResponse({ ...fixture, output }), /structured output JSON parse failed/);
});
test("invalid MemeResearch schema fails clearly", () => {
    assert.throws(() => parseMemeResearchResponse({ ...fixture, output_text: '{"memes":{}}' }),
        /invalid MemeResearch/);
});
test("web search is still required", () => {
    assert.throws(() => parseMemeResearchResponse({ ...fixture, output: fixture.output.slice(2) }),
        /did not use web_search/);
});
test("debug diagnostics and default error never expose raw response", () => {
    const diagnostics = responseDiagnostics(JSON.stringify(fixture));
    assert.match(diagnostics, /status=completed output=\[reasoning,web_search_call,message\]/);
    assert.doesNotMatch(diagnostics, /SECRET_ENCRYPTED_REASONING|NOT_MEME_DATA/);
    assert.doesNotMatch(formatMemeUpdateError(new TypeError(`Cannot use 'in' operator in ${JSON.stringify(fixture)}`)),
        /SECRET_ENCRYPTED_REASONING|NOT_MEME_DATA|resp_test/);
    assert.doesNotMatch(responseDiagnostics({ ...fixture, status: "SECRET_ENCRYPTED_REASONING",
        output: [{ type: "SECRET_ENCRYPTED_REASONING" }] }), /SECRET_ENCRYPTED_REASONING/);
});
test("raw SDK response bypasses its object-only parser for a stringified payload", async () => {
    const client = new OpenAI({ apiKey: "offline-test", baseURL: "https://example.invalid",
        fetch: async () => new Response(JSON.stringify(JSON.stringify(fixture)), {
            status: 200, headers: { "content-type": "application/json" },
        }),
    });
    const httpResponse = await client.responses.create({ model: "offline", input: "offline" },
        { maxRetries: 0 }).asResponse();
    assert.deepEqual(parseMemeResearchResponse(await httpResponse.json()), research);
});
