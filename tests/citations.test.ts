import assert from "node:assert/strict";
import test from "node:test";

import {
    collectMarkerSources,
    formatSourceName,
    normalizeUrlCitation,
    renderCitations,
    type UrlCitation,
} from "../src/ai/citations.js";

const markerA = "citeturn0search0";
const markerB = "citeturn0search1";

function cite(text: string, marker: string, url: string, title?: string): UrlCitation {
    const startIndex = text.indexOf(marker);
    assert.ok(startIndex >= 0);
    return { startIndex, endIndex: startIndex + marker.length, url, title };
}

test("single indexed citation renders a source link in place", () => {
    const text = `你说的应该是 Transformer 架构。${markerA}`;
    const url = "https://en.wikipedia.org/wiki/Transformer_(deep_learning_architecture)";
    const result = renderCitations(text, [cite(text, markerA, url, "Attention Is All You Need - Wikipedia")]);
    assert.equal(result.content, `你说的应该是 Transformer 架构。（[Wikipedia](${url})）`);
    assert.equal(result.renderedCount, 1);
});

test("multiple citations stay with their statements and reverse replacement preserves indices", () => {
    const text = `事实 A。${markerA} 事实 B。${markerB}`;
    const result = renderCitations(text, [
        cite(text, markerA, "https://openai.com/index/a"),
        cite(text, markerB, "https://github.com/example/repo"),
    ]);
    assert.equal(result.content,
        "事实 A。（[OpenAI](https://openai.com/index/a)） 事实 B。（[GitHub](https://github.com/example/repo)）");
    assert.equal(result.renderedCount, 2);
});

test("source names prefer known sites, then a short title, then the hostname", () => {
    assert.equal(formatSourceName("https://www.wikipedia.org/wiki/Test", "Some long article"), "Wikipedia");
    assert.equal(formatSourceName("https://openai.com/index/a"), "OpenAI");
    assert.equal(formatSourceName("https://developer.mozilla.org/en-US/docs/Web"), "MDN");
    assert.equal(formatSourceName("https://www.example.com/a"), "example.com");
    assert.equal(formatSourceName("https://news.example.com/a"), "news.example.com");
    assert.equal(formatSourceName("https://www.example.com/a", "Acme Research"), "Acme Research");
    assert.equal(formatSourceName("https://www.example.com/a", "A Very Long Article About Many Things That Happened Today"), "example.com");
});

test("invalid and non-http URLs never become Markdown links", () => {
    for (const url of ["javascript:alert(1)", "not a url", "https://example.com/\nspoof"]) {
        const text = `事实。${markerA}`;
        const result = renderCitations(text, [cite(text, markerA, url)]);
        assert.equal(result.content, "事实。");
        assert.equal(result.renderedCount, 0);
        assert.equal(result.metadataUnavailable, true);
    }
});

test("duplicate citations at one span and URL render once", () => {
    const text = `事实。${markerA}`;
    const citation = cite(text, markerA, "https://openai.com/index/a");
    const result = renderCitations(text, [citation, citation]);
    assert.equal(result.content, "事实。（[OpenAI](https://openai.com/index/a)）");
    assert.equal(result.renderedCount, 1);
});

test("the same URL cited at separate locations remains separate", () => {
    const text = `事实 A。${markerA} 事实 B。${markerB}`;
    const url = "https://openai.com/index/a";
    const result = renderCitations(text, [cite(text, markerA, url), cite(text, markerB, url)]);
    assert.equal(result.renderedCount, 2);
    assert.equal((result.content.match(/\[OpenAI\]/g) ?? []).length, 2);
});

test("different sources at one span share one compact citation group", () => {
    const text = `事实。${markerA}`;
    const result = renderCitations(text, [
        cite(text, markerA, "https://openai.com/a"),
        cite(text, markerA, "https://github.com/a"),
    ]);
    assert.equal(result.content,
        "事实。（[OpenAI](https://openai.com/a)、[GitHub](https://github.com/a)）");
});

test("metadata-free internal markers disappear and ordinary text is unchanged", () => {
    assert.deepEqual(renderCitations(`事实。${markerA}`, []), {
        content: "事实。", renderedCount: 0, metadataUnavailable: true,
    });
    assert.deepEqual(renderCitations("普通回答。", []), {
        content: "普通回答。", renderedCount: 0, metadataUnavailable: false,
    });
    assert.deepEqual(renderCitations("内部 ID turn0search0 也不能出现。", []), {
        content: "内部 ID  也不能出现。", renderedCount: 0, metadataUnavailable: true,
    });
});

test("Markdown syntax in an unknown source title is escaped", () => {
    const text = `事实。${markerA}`;
    const result = renderCitations(text, [cite(text, markerA, "https://example.com/a", "Acme [R&D] (Docs)")]);
    assert.equal(result.content, "事实。（[Acme \\[R&D\\] \\(Docs\\)](https://example.com/a)）");
});

test("internal-looking text inside a real source URL is preserved", () => {
    const text = `事实。${markerA}`;
    const url = "https://example.com/turn0search0";
    assert.equal(renderCitations(text, [cite(text, markerA, url, "Example")]).content,
        `事实。（[Example](${url})）`);
});

test("stream and completed annotations normalize to the SDK-independent shape", () => {
    assert.deepEqual(normalizeUrlCitation({
        type: "url_citation", start_index: 2, end_index: 5,
        title: "OpenAI", url: "https://openai.com/a",
    }), { startIndex: 2, endIndex: 5, title: "OpenAI", url: "https://openai.com/a" });
    assert.equal(normalizeUrlCitation({ type: "file_citation", url: "https://example.com" }), null);
});

test("qq_reply content can reuse only a marker linked by an annotated output part", () => {
    const outputText = `搜索结果：${markerA}`;
    const citations = [cite(outputText, markerA, "https://openai.com/index/a")];
    const sources = collectMarkerSources([{ text: outputText, citations }]);
    assert.equal(renderCitations(`最终回答。${markerA}`, [], sources).content,
        "最终回答。（[OpenAI](https://openai.com/index/a)）");
    assert.equal(renderCitations(`最终回答。${markerB}`, [], sources).content, "最终回答。");
});

test("conflicting metadata for one internal marker cannot invent a source", () => {
    const text = `事实。${markerA}`;
    const sources = collectMarkerSources([{ text, citations: [
        cite(text, markerA, "https://openai.com/a"),
        cite(text, markerA, "https://github.com/a"),
    ] }]);
    assert.equal(renderCitations(`回答。${markerA}`, [], sources).content, "回答。");
});

test("citation location after an emoji can use character indexes", () => {
    const text = `😀事实。${markerA}`;
    const citation = cite(text, markerA, "https://openai.com/a");
    citation.startIndex--;
    citation.endIndex--;
    assert.equal(renderCitations(text, [citation]).content,
        "😀事实。（[OpenAI](https://openai.com/a)）");
});

test("unusable offsets inside a marker cannot corrupt it or expose it", () => {
    const text = `事实。${markerA}`;
    const citation = cite(text, markerA, "https://openai.com/a");
    citation.startIndex += 2;
    citation.endIndex -= 2;
    assert.equal(renderCitations(text, [citation]).content, "事实。");
});

test("a cited text span keeps the sentence and adds its link at that location", () => {
    const text = "事实 A。事实 B。";
    const result = renderCitations(text, [{
        startIndex: 0, endIndex: 5, url: "https://openai.com/a",
    }]);
    assert.equal(result.content, "事实 A。（[OpenAI](https://openai.com/a)）事实 B。");
});

test("offline Responses stream renders citations in output_text and multi-message qq_reply", async () => {
    process.env.CODEX_API_KEY = "offline-test";
    process.env.CODEX_BASE_URL = "https://example.invalid";
    const { chat } = await import("../src/ai/client.js");
    const text = `事实。${markerA}`;
    const annotation = {
        type: "url_citation", start_index: text.indexOf(markerA),
        end_index: text.length, title: "OpenAI", url: "https://openai.com/a",
    };
    const part = (annotations: unknown[]) => ({ type: "output_text", text, annotations });
    const complete = (output: unknown[]) => ({ type: "response.completed", response: { output } });
    const streams = [
        [
            { type: "response.output_text.annotation.added", output_index: 0, content_index: 0,
                annotation_index: 0, annotation },
            complete([{ type: "message", content: [part([])] }]),
        ],
        [complete([
            { type: "message", content: [part([annotation])] },
            { type: "function_call", name: "qq_reply", arguments: JSON.stringify({
                messages: [text, "补一句"], mentions: [], quote: "auto",
            }) },
        ])],
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
        const events = streams.shift();
        if (!events) throw new Error("Unexpected offline AI call");
        const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") +
            "data: [DONE]\n\n";
        return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    try {
        const options = { signal: new AbortController().signal };
        const plain = await chat("offline", options);
        const tool = await chat("offline", options);
        assert.equal(plain.kind, "reply");
        assert.equal(tool.kind, "reply");
        if (plain.kind !== "reply" || tool.kind !== "reply") return;
        assert.deepEqual(plain.action.messages, ["事实。（[OpenAI](https://openai.com/a)）"]);
        assert.deepEqual(tool.action.messages, ["事实。（[OpenAI](https://openai.com/a)）", "补一句"]);
    } finally {
        globalThis.fetch = originalFetch;
    }
});
