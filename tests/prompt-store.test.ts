import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PromptStore } from "../src/ai/prompt-store.js";
import { runModelPlugin } from "../src/ai/client.js";
import type { ModelPlugin } from "../src/ai/model-plugin.js";
import { FileChangeWatcher } from "../src/shared/file-change-watcher.js";

test("PromptStore loads provider files independently and preserves old Attempt snapshots", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tenbot-prompts-"));
    const paths = { gpt: join(directory, "gpt.md"), deepseek: join(directory, "deepseek.md") };
    try {
        await writeFile(paths.gpt, "GPT prompt A", "utf8");
        await writeFile(paths.deepseek, "DeepSeek prompt A", "utf8");
        const store = new PromptStore(paths);
        await store.loadAll();
        const oldAttempt = store.get("gpt");
        assert.equal(store.get("deepseek").content, "DeepSeek prompt A");

        await writeFile(paths.gpt, "GPT prompt B", "utf8");
        await store.reload("gpt");
        assert.equal(oldAttempt.content, "GPT prompt A");
        assert.equal(store.get("gpt").content, "GPT prompt B");
        assert.equal(store.get("deepseek").content, "DeepSeek prompt A");
    } finally {
        await rm(paths.gpt, { force: true });
        await rm(paths.deepseek, { force: true });
        await rmdir(directory);
    }
});

test("PromptStore reload failure keeps the previously active snapshot", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tenbot-prompt-failure-"));
    const gptPath = join(directory, "gpt.md");
    const deepseekPath = join(directory, "deepseek.md");
    try {
        await writeFile(gptPath, "valid prompt", "utf8");
        await writeFile(deepseekPath, "valid other prompt", "utf8");
        const store = new PromptStore({ gpt: gptPath, deepseek: deepseekPath });
        await store.loadAll();
        const previous = store.get("gpt");
        await writeFile(gptPath, "  \n", "utf8");
        await assert.rejects(store.reload("gpt"), /must not be empty/);
        assert.equal(store.get("gpt"), previous);
        await rm(gptPath);
        await assert.rejects(store.reload("gpt"));
        assert.equal(store.get("gpt"), previous);
    } finally {
        await rm(gptPath, { force: true });
        await rm(deepseekPath, { force: true });
        await rmdir(directory);
    }
});

test("Prompt watcher updates the next ModelRequest while an in-flight request keeps its captured prompt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tenbot-prompt-watch-"));
    const gptPath = join(directory, "gpt.md");
    const deepseekPath = join(directory, "deepseek.md");
    const tempPath = join(directory, "gpt.next");
    let releaseFirst!: () => void;
    const requests: string[] = [];
    const plugin: ModelPlugin = {
        id: "gpt", model: "offline", capabilities: { webSearch: false },
        async generate(request) {
            requests.push(request.systemPrompt);
            if (requests.length === 1) return await new Promise((resolve) => {
                releaseFirst = () => resolve({ kind: "no_reply" });
            });
            return { kind: "no_reply" };
        },
    };
    let watcher: FileChangeWatcher | undefined;
    const waitFor = async (predicate: () => boolean) => {
        const started = Date.now();
        while (!predicate()) {
            if (Date.now() - started > 2000) throw new Error("condition timed out");
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
    };
    try {
        await writeFile(gptPath, "TEST_PROMPT_VERSION_A", "utf8");
        await writeFile(deepseekPath, "DEEPSEEK_PROMPT_INDEPENDENT", "utf8");
        const store = new PromptStore({ gpt: gptPath, deepseek: deepseekPath });
        const promptA = await store.load("gpt");
        watcher = new FileChangeWatcher(gptPath, async () => { await store.reload("gpt"); }, 35);
        await watcher.start();

        const firstAttempt = runModelPlugin(plugin, "offline", { signal: new AbortController().signal }, promptA);
        await waitFor(() => requests.length === 1);
        await writeFile(tempPath, "TEST_PROMPT_VERSION_B", "utf8");
        await rename(tempPath, gptPath);
        await waitFor(() => store.get("gpt").revision === promptA.revision + 1);
        const promptB = store.get("gpt");
        await runModelPlugin(plugin, "offline", { signal: new AbortController().signal }, promptB);
        assert.deepEqual(requests, ["TEST_PROMPT_VERSION_A", "TEST_PROMPT_VERSION_B"]);
        assert.equal(store.get("deepseek").content, "DEEPSEEK_PROMPT_INDEPENDENT");

        releaseFirst();
        await firstAttempt;
    } finally {
        watcher?.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test("migrated Prompt files contain provider-specific content", async () => {
    const gpt = await readFile(new URL("../src/ai/plugins/gpt/prompt.md", import.meta.url), "utf8");
    const deepseek = await readFile(new URL("../src/ai/plugins/deepseek/prompt.md", import.meta.url), "utf8");
    assert.notEqual(gpt, deepseek);
    assert.match(gpt, /一般不主动插话/);
    assert.match(deepseek, /一般不主动插话/);
    assert.doesNotMatch(gpt, /GPT-6 Sol/);
    assert.match(deepseek, /web_search/);
});
