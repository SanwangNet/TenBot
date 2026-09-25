import assert from "node:assert/strict";
import { mkdtemp, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { rankMemeMatches } from "../src/skills/meme/search.js";
import { MemeStore, sampleRecentMemeNames } from "../src/skills/meme/store.js";

function entry(id: string, name: string) {
    return { id, name, aliases: [], summary: `${name} summary`, origin: "origin", meaning: "meaning", usage: "usage", examples: [] };
}

test("recent meme sample keeps source order with the newest entry at the bottom", () => {
    assert.deepEqual(sampleRecentMemeNames(["A", "B", "C", "D", "E"].map((name, i) => entry(String(i), name)), 3), ["C", "D", "E"]);
});

test("MemeStore reload builds a new complete index while old snapshots stay usable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tenbot-memes-"));
    const file = join(directory, "memes.json");
    try {
        await writeFile(file, JSON.stringify([entry("meme-a", "alpha meme")]), "utf8");
        const store = new MemeStore(file);
        const old = await store.loadInitial();
        await writeFile(file, JSON.stringify([entry("meme-a", "alpha meme"), entry("meme-b", "beta meme")]), "utf8");
        const next = await store.reload();
        assert.equal(next.entries.length, 2);
        assert.equal(old.entries.length, 1);
        assert.ok(!rankMemeMatches(old.index, "beta meme").some((match) => match.entry.id === "meme-b"));
        assert.equal(rankMemeMatches(next.index, "beta meme")[0]?.entry.id, "meme-b");
    } finally {
        await rm(file, { force: true });
        await rmdir(directory);
    }
});

test("MemeStore reload failures keep the previous data and index", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tenbot-meme-failure-"));
    const file = join(directory, "memes.json");
    try {
        await writeFile(file, JSON.stringify([entry("meme-a", "alpha meme")]), "utf8");
        const store = new MemeStore(file);
        const previous = await store.loadInitial();
        const invalidDocuments = [
            "{ invalid json",
            JSON.stringify([{ id: "meme-a" }]),
            JSON.stringify([entry("meme-a", "alpha meme"), entry("meme-a", "beta meme")]),
        ];
        for (const invalid of invalidDocuments) {
            await writeFile(file, invalid, "utf8");
            await assert.rejects(store.reload());
            assert.equal(store.getSnapshot(), previous);
            assert.equal(rankMemeMatches(store.getSnapshot().index, "alpha meme")[0]?.entry.id, "meme-a");
        }
    } finally {
        await rm(file, { force: true });
        await rmdir(directory);
    }
});
