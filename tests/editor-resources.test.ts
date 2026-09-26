import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEditorResourceStore, isEditorResourceId } from "../src/control/editor-resources.js";

async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), "tenbot-editor-test-"));
    const paths = {
        "prompt:gpt": join(directory, "gpt.md"),
        "prompt:deepseek": join(directory, "deepseek.md"),
        "prompt:reply-judge": join(directory, "judge.md"),
        "meme:data": join(directory, "memes.json"),
    } as const;
    await Promise.all([
        writeFile(paths["prompt:gpt"], "GPT prompt", "utf8"),
        writeFile(paths["prompt:deepseek"], "DeepSeek prompt", "utf8"),
        writeFile(paths["prompt:reply-judge"], "Judge prompt", "utf8"),
        writeFile(paths["meme:data"], "[]\n", "utf8"),
    ]);
    const reloaded: string[] = [];
    const store = createEditorResourceStore({
        "prompt:gpt": { path: paths["prompt:gpt"], displayName: "GPT", language: "markdown", async reload() { reloaded.push("gpt"); return { ok: true, message: "ok", loadedAt: "now" }; } },
        "prompt:deepseek": { path: paths["prompt:deepseek"], displayName: "DeepSeek", language: "markdown", async reload() { reloaded.push("deepseek"); return { ok: true, message: "ok", loadedAt: "now" }; } },
        "prompt:reply-judge": { path: paths["prompt:reply-judge"], displayName: "Judge", language: "markdown", async reload() { reloaded.push("judge"); return { ok: true, message: "ok", loadedAt: "now" }; } },
        "meme:data": { path: paths["meme:data"], displayName: "Meme", language: "json", async reload() { reloaded.push("meme"); return { ok: true, message: "ok", loadedAt: "now" }; } },
    });
    return { directory, paths, store, reloaded };
}

test("editor allowlist rejects arbitrary path and secret names", () => {
    for (const invalid of ["../.env", "C:\\Users\\secret", ".env", "apiKey", "prompt:../.env"]) assert.equal(isEditorResourceId(invalid), false);
    assert.equal(isEditorResourceId("prompt:reply-judge"), true);
});

test("prompt save checks version, atomically replaces file, and invokes the matching reload", async () => {
    const { directory, paths, store, reloaded } = await fixture();
    try {
        const first = await store.get("prompt:gpt");
        assert.equal(first.content, "GPT prompt");
        assert.equal(first.version.length, 64);
        const saved = await store.save("prompt:gpt", "Updated GPT prompt\n", first.version);
        assert.equal(saved.ok, true);
        assert.deepEqual(reloaded, ["gpt"]);
        assert.equal(await readFile(paths["prompt:gpt"], "utf8"), "Updated GPT prompt\n");
        assert.equal((await readdir(directory)).some((name) => name.endsWith(".tmp")), false);
        const conflict = await store.save("prompt:gpt", "stale", first.version);
        assert.deepEqual(conflict, { ok: false, reason: "conflict", message: "File changed on the server" });
        assert.equal(await readFile(paths["prompt:gpt"], "utf8"), "Updated GPT prompt\n");
        const judge = await store.get("prompt:reply-judge");
        assert.equal((await store.save("prompt:reply-judge", "Updated Judge", judge.version)).ok, true);
        assert.deepEqual(reloaded, ["gpt", "judge"]);
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test("invalid prompts and Meme JSON/schema never replace files; valid Meme data reloads", async () => {
    const { directory, paths, store, reloaded } = await fixture();
    try {
        const prompt = await store.get("prompt:deepseek");
        assert.equal((await store.save("prompt:deepseek", "   ", prompt.version)).ok, false);
        assert.equal((await store.save("prompt:deepseek", "bad \ud800", prompt.version)).ok, false);
        assert.equal(await readFile(paths["prompt:deepseek"], "utf8"), "DeepSeek prompt");
        const meme = await store.get("meme:data");
        assert.deepEqual(await store.save("meme:data", "{", meme.version), { ok: false, reason: "invalid", message: "Invalid JSON" });
        assert.equal((await store.save("meme:data", "[{}]", meme.version)).ok, false);
        assert.equal(await readFile(paths["meme:data"], "utf8"), "[]\n");
        const saved = await store.save("meme:data", "[]", meme.version);
        assert.equal(saved.ok, true);
        assert.deepEqual(reloaded, ["meme"]);
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test("reload failure reports saved file separately from active Runtime snapshot", async () => {
    const { directory, paths, store } = await fixture();
    try {
        const current = await store.get("prompt:gpt");
        const failing = createEditorResourceStore({
            "prompt:gpt": { path: paths["prompt:gpt"], displayName: "GPT", language: "markdown", async reload() { throw new Error("private stack"); } },
            "prompt:deepseek": { path: paths["prompt:deepseek"], displayName: "DeepSeek", language: "markdown", async reload() { return { ok: true, message: "ok", loadedAt: "now" }; } },
            "prompt:reply-judge": { path: paths["prompt:reply-judge"], displayName: "Judge", language: "markdown", async reload() { return { ok: true, message: "ok", loadedAt: "now" }; } },
            "meme:data": { path: paths["meme:data"], displayName: "Meme", language: "json", async reload() { return { ok: true, message: "ok", loadedAt: "now" }; } },
        });
        const result = await failing.save("prompt:gpt", "saved despite reload", current.version);
        assert.equal(result.ok, true);
        if (result.ok) { assert.equal(result.reload.ok, false); assert.doesNotMatch(result.reload.message, /private stack/); }
        assert.equal(await readFile(paths["prompt:gpt"], "utf8"), "saved despite reload");
    } finally { await rm(directory, { recursive: true, force: true }); }
});
