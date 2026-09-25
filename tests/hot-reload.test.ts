import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureAttemptRuntimeSnapshot } from "../src/ai/attempt-snapshot.js";
import type { ModelPlugin } from "../src/ai/model-plugin.js";
import { createConfigStore } from "../src/config/config-store.js";
import { loadAppConfig } from "../src/config/config-validation.js";
import { FileChangeWatcher } from "../src/shared/file-change-watcher.js";
import { RuntimeConfigSnapshotStore } from "../src/runtime-config-snapshot.js";

function fakePlugin(id: string, model: string): ModelPlugin {
    return { id, model, capabilities: { webSearch: false }, async generate() { throw new Error("not called"); } };
}

test("RuntimeConfigSnapshotStore swaps future Attempt plugins and preserves in-flight snapshots", () => {
    const initialConfig = loadAppConfig({ AI_PROVIDER: "gpt", CODEX_MODEL: "gpt-old" });
    let active: ModelPlugin | undefined;
    let failDeepSeek = true;
    const store = new RuntimeConfigSnapshotStore(initialConfig, (config) => {
        if (config.ai.provider === "deepseek" && failDeepSeek) throw new Error("builder failure");
        return fakePlugin(config.ai.provider, config.ai.provider === "gpt" ? config.ai.gpt.model : config.ai.deepseek.model);
    }, (plugin) => { active = plugin; });
    const oldAttemptPlugin = store.get().model;
    const deepseekConfig = structuredClone(initialConfig);
    deepseekConfig.ai.provider = "deepseek";
    assert.throws(() => store.replace(deepseekConfig), /builder failure/);
    assert.equal(store.get().model, oldAttemptPlugin, "failed build leaves the whole old snapshot active");
    assert.equal(active, oldAttemptPlugin);

    failDeepSeek = false;
    const next = store.replace(deepseekConfig);
    assert.equal(next.revision, 2);
    assert.equal(next.model.id, "deepseek");
    assert.equal(active, next.model);
    assert.equal(oldAttemptPlugin.id, "gpt", "an in-flight Attempt retains its captured plugin");
    assert.equal(oldAttemptPlugin.model, "gpt-old");
});

test("the production model registry pointer is replaced for later Attempt snapshots", () => {
    const initialConfig = loadAppConfig({ AI_PROVIDER: "gpt", CODEX_MODEL: "gpt-old" });
    const store = new RuntimeConfigSnapshotStore(initialConfig);
    const attempt1 = captureAttemptRuntimeSnapshot();
    const deepseekConfig = structuredClone(initialConfig);
    deepseekConfig.ai.provider = "deepseek";
    deepseekConfig.ai.deepseek.model = "deepseek-new";

    store.replace(deepseekConfig);
    const attempt2 = captureAttemptRuntimeSnapshot();
    assert.equal(attempt1.model.revision, 1);
    assert.equal(attempt1.model.provider, "gpt");
    assert.equal(attempt1.model.model.model, "gpt-old");
    assert.equal(attempt2.model.revision, 2);
    assert.equal(attempt2.model.provider, "deepseek");
    assert.equal(attempt2.model.model.model, "deepseek-new");
    assert.equal(attempt1.prompt.provider, "gpt");
    assert.equal(attempt2.prompt.provider, "deepseek");
});

test("FileChangeWatcher observes atomic rename saves once after debounce", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tenbot-watch-"));
    const file = join(directory, ".env");
    const tempFile = join(directory, ".env.next");
    const watcher = new FileChangeWatcher(file, async () => { changed(); }, 40);
    let notify!: () => void;
    let changed = () => notify();
    let count = 0;
    let resolveChange!: () => void;
    const seen = new Promise<void>((resolve) => { resolveChange = resolve; });
    changed = () => { count++; resolveChange(); };
    try {
        await writeFile(file, "AI_PROVIDER=gpt\n", "utf8");
        await watcher.start();
        await writeFile(tempFile, "AI_PROVIDER=deepseek\n", "utf8");
        await rename(tempFile, file);
        await Promise.race([seen, new Promise((_, reject) => setTimeout(() => reject(new Error("watch timeout")), 2000))]);
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(count, 1);
        assert.match(await readFile(file, "utf8"), /deepseek/);
    } finally {
        watcher.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test("external env watcher rebuilds the active provider snapshot and keeps the old one on invalid config", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tenbot-config-runtime-"));
    const envPath = join(directory, ".env");
    const tempPath = join(directory, ".env.next");
    await writeFile(envPath, "AI_PROVIDER=gpt\nCODEX_MODEL=gpt-old\n", "utf8");
    const store = createConfigStore({ envPath, environment: {} });
    let active: ModelPlugin | undefined;
    let activeRevision = 0;
    let failedReloads = 0;
    const snapshots = new RuntimeConfigSnapshotStore(store.getAppConfig(), (config) => fakePlugin(
        config.ai.provider,
        config.ai.provider === "gpt" ? config.ai.gpt.model : config.ai.deepseek.model,
    ), (plugin, revision) => { active = plugin; activeRevision = revision; });
    const watcher = new FileChangeWatcher(envPath, async () => {
        try { snapshots.replace(store.getAppConfig()); }
        catch { failedReloads++; }
    }, 35);
    const waitFor = async (predicate: () => boolean) => {
        const started = Date.now();
        while (!predicate()) {
            if (Date.now() - started > 2000) throw new Error("condition timed out");
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
    };
    try {
        await watcher.start();
        const attempt1 = snapshots.get().model;
        await writeFile(tempPath, "AI_PROVIDER=deepseek\nDEEPSEEK_MODEL=deepseek-new\n", "utf8");
        await rename(tempPath, envPath);
        await waitFor(() => activeRevision === 2);
        const attempt2 = active;
        assert.equal(attempt1.id, "gpt");
        assert.equal(attempt1.model, "gpt-old");
        assert.equal(attempt2?.id, "deepseek");
        assert.equal(attempt2?.model, "deepseek-new");
        assert.equal(snapshots.get().revision, 2);

        await writeFile(tempPath, "AI_PROVIDER=not-a-provider\n", "utf8");
        await rename(tempPath, envPath);
        await waitFor(() => failedReloads === 1);
        assert.equal(active, attempt2, "a failed parse leaves the active plugin unchanged");
        assert.equal(snapshots.get().revision, 2);
    } finally {
        watcher.close();
        await rm(directory, { recursive: true, force: true });
    }
});
