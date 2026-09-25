import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PromptStore } from "../src/ai/prompt-store.js";

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

test("migrated Prompt files contain provider-specific content", async () => {
    const gpt = await readFile(new URL("../src/ai/plugins/gpt/prompt.md", import.meta.url), "utf8");
    const deepseek = await readFile(new URL("../src/ai/plugins/deepseek/prompt.md", import.meta.url), "utf8");
    assert.notEqual(gpt, deepseek);
    assert.match(gpt, /GPT-6 Sol/);
    assert.match(deepseek, /web_search/);
});
