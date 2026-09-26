import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { runModelPlugin as runModelPluginWithSnapshot, type ChatOptions } from "../src/ai/client.js";
import { createModelPlugin } from "../src/ai/model-registry.js";
import { ModelAbortedError, type ModelRequest } from "../src/ai/model-plugin.js";
import { createDeepSeekPlugin } from "../src/ai/plugins/deepseek/index.js";
import { createGptPlugin } from "../src/ai/plugins/gpt/index.js";
import { getPromptStore } from "../src/ai/prompt-store.js";
import { isToolProtocolLeak } from "../src/ai/tool-protocol.js";

const GPT_SYSTEM_PROMPT = readFileSync(new URL("../src/ai/plugins/gpt/prompt.md", import.meta.url), "utf8");
const DEEPSEEK_SYSTEM_PROMPT = readFileSync(new URL("../src/ai/plugins/deepseek/prompt.md", import.meta.url), "utf8");

type ResponseEvent = Record<string, any>;
function complete(output: unknown[]): ResponseEvent {
    return { type: "response.completed", response: { output } };
}
function messageText(text: string): ResponseEvent {
    return complete([{ type: "message", content: [{ type: "output_text", text, annotations: [] }] }]);
}
function sse(events: ResponseEvent[]): Response {
    const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}
function pluginRequest(input = "offline", systemPrompt = "offline provider prompt"): ModelRequest {
    return { input, systemPrompt, tools: [], executeTool: async () => ({ kind: "ignore" }) };
}
function options(signal = new AbortController().signal) {
    return { signal };
}
function runModelPlugin(
    plugin: ReturnType<typeof createGptPlugin> | ReturnType<typeof createDeepSeekPlugin>,
    input: string,
    generateOptions: ChatOptions,
    promptSnapshot = getPromptStore().getForModel(plugin.id),
) {
    assert.ok(promptSnapshot, `missing Prompt snapshot for ${plugin.id}`);
    return runModelPluginWithSnapshot(plugin, input, generateOptions, promptSnapshot);
}
async function withResponses(responses: Response[], run: (bodies: Record<string, any>[]) => Promise<void>): Promise<void> {
    const originalFetch = globalThis.fetch;
    const bodies: Record<string, any>[] = [];
    globalThis.fetch = async (_request, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, any>);
        const response = responses.shift();
        if (!response) throw new Error("Unexpected offline model call");
        return response;
    };
    try { await run(bodies); }
    finally { globalThis.fetch = originalFetch; }
}

test("registry selects GPT, DeepSeek, and defaults to GPT without requiring credentials", () => {
    assert.equal(createModelPlugin({ AI_PROVIDER: "gpt" }).id, "gpt");
    assert.equal(createModelPlugin({ AI_PROVIDER: "deepseek" }).id, "deepseek");
    assert.equal(createModelPlugin({}).id, "gpt");
    assert.equal(createModelPlugin({ AI_PROVIDER: "deepseek", DEEPSEEK_MODEL: "custom" }).model, "custom");
    const configuredGpt = createModelPlugin({ AI_PROVIDER: "gpt", CODEX_MODEL: "gpt-next", CODEX_REASONING_EFFORT: "xhigh", CODEX_VERBOSITY: "low" });
    assert.equal(configuredGpt.model, "gpt-next");
    assert.equal(configuredGpt.reasoningEffort, "xhigh");
    assert.equal(configuredGpt.verbosity, "low");
    const configuredDeepSeek = createModelPlugin({ AI_PROVIDER: "deepseek", DEEPSEEK_REASONING_EFFORT: "low" });
    assert.equal(configuredDeepSeek.reasoningEffort, "low");
    assert.throws(() => createModelPlugin({ AI_PROVIDER: "other" }), /不支持的 AI_PROVIDER/);
});

test("GPT and DeepSeek use isolated provider prompts and keep the same persona", async () => {
    assert.notEqual(GPT_SYSTEM_PROMPT, DEEPSEEK_SYSTEM_PROMPT);
    assert.match(GPT_SYSTEM_PROMPT, /GPT-6 Sol/);
    assert.doesNotMatch(DEEPSEEK_SYSTEM_PROMPT, /GPT-6 Sol/);
    assert.match(DEEPSEEK_SYSTEM_PROMPT, /没有 web_search 工具/);
    assert.doesNotMatch(DEEPSEEK_SYSTEM_PROMPT, /才使用 web_search/);
    assert.match(GPT_SYSTEM_PROMPT, /你叫“小尘”/);
    assert.match(DEEPSEEK_SYSTEM_PROMPT, /你叫“小尘”/);
    await withResponses([sse([messageText("收到")]), sse([messageText("收到")])], async (bodies) => {
        await createGptPlugin({ apiKey: "offline", baseURL: "https://example.invalid" })
            .generate(pluginRequest("offline", GPT_SYSTEM_PROMPT), options());
        await createDeepSeekPlugin({ apiKey: "offline" })
            .generate(pluginRequest("offline", DEEPSEEK_SYSTEM_PROMPT), options());
        assert.equal(bodies[0].instructions, GPT_SYSTEM_PROMPT);
        assert.equal(bodies[1].instructions, DEEPSEEK_SYSTEM_PROMPT);
    });
});

test("Runtime ModelRequest captures the selected PromptStore snapshot", async () => {
    const gpt = createGptPlugin({ apiKey: "offline", baseURL: "https://example.invalid" });
    const deepseek = createDeepSeekPlugin({ apiKey: "offline" });
    const gptPrompt = getPromptStore().get("gpt");
    const deepseekPrompt = getPromptStore().get("deepseek");
    await withResponses([sse([messageText("GPT")]), sse([messageText("DeepSeek")])], async (bodies) => {
        await runModelPlugin(gpt, "offline", { signal: new AbortController().signal }, gptPrompt);
        await runModelPlugin(deepseek, "offline", { signal: new AbortController().signal }, deepseekPrompt);
        assert.equal(bodies[0].instructions, GPT_SYSTEM_PROMPT);
        assert.equal(bodies[1].instructions, DEEPSEEK_SYSTEM_PROMPT);
    });
});

test("GPT declares built-in web search while DeepSeek omits it and still completes chat", async () => {
    const gpt = createGptPlugin({ apiKey: "offline", baseURL: "https://example.invalid" });
    const deepseek = createDeepSeekPlugin({ apiKey: "offline" });
    assert.equal(gpt.capabilities.webSearch, true);
    assert.equal(deepseek.capabilities.webSearch, false);
    assert.equal(gpt.reasoningEffort, "high");
    assert.equal(gpt.verbosity, "high");
    assert.equal(deepseek.reasoningEffort, "high");
    assert.equal(deepseek.verbosity, undefined);
    await withResponses([sse([messageText("GPT")]), sse([messageText("DeepSeek")])], async (bodies) => {
        const gptResult = await gpt.generate(pluginRequest(), options());
        const deepseekResult = await deepseek.generate(pluginRequest(), options());
        assert.equal(gptResult.kind, "reply");
        assert.equal(deepseekResult.kind, "reply");
        assert.ok(bodies[0].tools.some((tool: { type: string }) => tool.type === "web_search"));
        assert.ok(!bodies[1].tools.some((tool: { type: string }) => tool.type === "web_search"));
    });
});

test("GPT web search provider event becomes the Runtime callback", async () => {
    await withResponses([sse([
        { type: "response.web_search_call.in_progress" },
        messageText("有结果了"),
    ])], async () => {
        let webSearchStarted = 0;
        const result = await runModelPlugin(
            createGptPlugin({ apiKey: "offline", baseURL: "https://example.invalid" }),
            "offline",
            { signal: new AbortController().signal, onWebSearchStart: () => { webSearchStarted++; } },
        );
        assert.equal(result.kind, "reply");
        assert.equal(webSearchStarted, 1);
    });
});

test("GPT and DeepSeek function calls normalize to the same TenBot qq_reply action", async () => {
    const argumentsJson = JSON.stringify({
        messages: [{ content: "好的", quote: { mode: "message", ref: "m2" } }],
        mentions: ["小王"],
    });
    const toolCall = complete([{ type: "function_call", id: "fc_1", call_id: "call_1", name: "qq_reply", arguments: argumentsJson }]);
    const gpt = createGptPlugin({ apiKey: "offline", baseURL: "https://example.invalid" });
    const deepseek = createDeepSeekPlugin({ apiKey: "offline" });
    await withResponses([sse([toolCall]), sse([toolCall])], async (bodies) => {
        const gptResult = await runModelPlugin(gpt, "offline", options());
        const deepseekResult = await runModelPlugin(deepseek, "offline", options());
        assert.deepEqual(gptResult, deepseekResult);
        assert.deepEqual(gptResult, {
            kind: "reply",
            action: {
                messages: [{ content: "好的", quote: { mode: "message", ref: "m2" } }],
                mentions: ["小王"],
            },
        });
        const names = (body: Record<string, any>) => body.tools
            .filter((tool: { type: string }) => tool.type === "function")
            .map((tool: { name: string }) => tool.name);
        assert.deepEqual(names(bodies[0]), ["qq_reply", "meme_lookup"]);
        assert.deepEqual(names(bodies[1]), ["qq_reply", "meme_lookup"]);
    });
});

test("GPT and DeepSeek expose the same NO_REPLY result", async () => {
    await withResponses([sse([messageText("<NO_REPLY>")]), sse([messageText("<NO_REPLY>")])], async () => {
        const gpt = await runModelPlugin(createGptPlugin({ apiKey: "offline", baseURL: "https://example.invalid" }), "offline", options());
        const deepseek = await runModelPlugin(createDeepSeekPlugin({ apiKey: "offline" }), "offline", options());
        assert.deepEqual(gpt, { kind: "no_reply" });
        assert.deepEqual(deepseek, gpt);
    });
});

test("a real qq_reply function call with NO_REPLY remains a control result", async () => {
    const toolCall = complete([{
        type: "function_call", id: "fc_silent", call_id: "call_silent", name: "qq_reply",
        arguments: JSON.stringify({
            messages: [{ content: "<NO_REPLY>", quote: { mode: "none", ref: null } }],
            mentions: [],
        }),
    }]);
    await withResponses([sse([toolCall])], async () => {
        const result = await runModelPlugin(createDeepSeekPlugin({ apiKey: "offline" }), "offline", options());
        assert.deepEqual(result, { kind: "no_reply" });
    });
});

test("DeepSeek meme_lookup uses the shared TenBot tool and feeds its result back", async () => {
    const memeCall = complete([{
        type: "function_call", id: "fc_meme", call_id: "call_meme", name: "meme_lookup",
        arguments: JSON.stringify({ query: "kskbl" }),
    }]);
    await withResponses([sse([memeCall]), sse([messageText("明白了")])], async (bodies) => {
        const result = await runModelPlugin(createDeepSeekPlugin({ apiKey: "offline" }), "这个梗是什么", options());
        assert.equal(result.kind, "reply");
        assert.equal(bodies.length, 2);
        const followup = bodies[1].input as Array<{ type?: string; call_id?: string; output?: string }>;
        const output = followup.find((item) => item.type === "function_call_output");
        assert.equal(output?.call_id, "call_meme");
        assert.match(output?.output ?? "", /康神开播了/);
    });
});

test("incomplete model response streams use the model-generation code", async () => {
    const plugin = createDeepSeekPlugin({ apiKey: "offline" });
    await withResponses([sse([{ type: "response.incomplete", response: { status: "incomplete" } }])], async () => {
        await assert.rejects(plugin.generate(pluginRequest(), options()),
            (error: unknown) => (error as { code?: string }).code === "M:A_MG_IRS");
    });
});

test("complete pseudo protocol text is rejected and gets one bounded recovery attempt", async () => {
    const pseudoTool = "<qq_reply>{\"messages\":[{\"content\":\"伪调用\"}]}</qq_reply>";
    await withResponses([sse([messageText(pseudoTool)]), sse([messageText("普通回复")])], async (bodies) => {
        const result = await runModelPlugin(createDeepSeekPlugin({ apiKey: "offline" }), "offline", options());
        assert.equal(result.kind, "reply");
        if (result.kind === "reply") assert.equal(result.action.messages[0].content, "普通回复");
        assert.equal(bodies.length, 2, "leaked output causes exactly one recovery request");
        assert.match(String(bodies[1]?.input), /必须调用实际的 qq_reply 工具/);
    });
});

test("protocol leak detector catches complete XML and reply JSON shapes only", () => {
    assert.equal(isToolProtocolLeak("<qq_reply>\n<messages/>\n</qq_reply>"), true);
    assert.equal(isToolProtocolLeak(JSON.stringify([
        { content: "hello", quote: { mode: "auto", ref: null } },
    ])), true);
    assert.equal(isToolProtocolLeak(JSON.stringify({
        messages: [{ content: "hello", quote: { mode: "message", ref: "m1" } }],
        mentions: [],
    })), true);
    assert.equal(isToolProtocolLeak("刚才那个 <qq_reply> 标签是什么意思？"), false);
    assert.equal(isToolProtocolLeak("这个 JSON 里有 content 字段"), false);
    assert.equal(isToolProtocolLeak('{"content":"普通 JSON 讨论"}'), false);
    assert.equal(isToolProtocolLeak("```xml\n<qq_reply>举例</qq_reply>\n```"), false);
});

test("a second leaked payload fails closed without sending it as text", async () => {
    const payloads = [
        "<qq_reply><messages/></qq_reply>",
        JSON.stringify([{ content: "泄漏", quote: { mode: "auto", ref: null } }]),
    ];
    await withResponses(payloads.map((payload) => sse([messageText(payload)])), async (bodies) => {
        await assert.rejects(
            runModelPlugin(createDeepSeekPlugin({ apiKey: "offline" }), "offline", options()),
        (error: unknown) => (error as { code?: string }).code === "B:A_OP_TPL",
        );
        assert.equal(bodies.length, 2);
    });
});

test("aborting either built-in plugin aborts its request and resolves as an aborted state", async () => {
    for (const create of [
        () => createGptPlugin({ apiKey: "offline", baseURL: "https://example.invalid" }),
        () => createDeepSeekPlugin({ apiKey: "offline" }),
    ]) {
        const originalFetch = globalThis.fetch;
        const controller = new AbortController();
        let requestSignal: AbortSignal | null = null;
        let announce!: () => void;
        const requested = new Promise<void>((resolve) => { announce = resolve; });
        globalThis.fetch = async (_request, init) => await new Promise<Response>((_resolve, reject) => {
            requestSignal = init?.signal as AbortSignal;
            announce();
            requestSignal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
        try {
            const pending = create().generate(pluginRequest(), { signal: controller.signal });
            await requested;
            controller.abort();
            await assert.rejects(pending, (error: unknown) => error instanceof ModelAbortedError);
            assert.equal((requestSignal as unknown as AbortSignal).aborted, true);
        } finally { globalThis.fetch = originalFetch; }
    }
});
