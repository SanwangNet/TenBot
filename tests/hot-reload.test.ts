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

test("Front mode hot swaps with runtime config; invalid Judge config leaves the previous snapshot active", () => {
    const legacyConfig = loadAppConfig({ FRONT_MODE: "legacy", AI_PROVIDER: "gpt" });
    const snapshots = new RuntimeConfigSnapshotStore(legacyConfig, (config) => fakePlugin(
        config.ai.provider,
        config.ai.provider === "gpt" ? config.ai.gpt.model : config.ai.deepseek.model,
    ), () => undefined);
    const inFlight = snapshots.get();
    assert.equal(inFlight.appConfig.frontMode, "legacy");

    assert.throws(() => snapshots.replace(loadAppConfig({ FRONT_MODE: "judge", AI_PROVIDER: "gpt" })), /REPLY_JUDGE_PROVIDER/);
    assert.equal(snapshots.get(), inFlight);

    const judgeConfig = loadAppConfig({
        FRONT_MODE: "judge",
        AI_PROVIDER: "gpt",
        REPLY_JUDGE_PROVIDER: "openai-compatible",
        REPLY_JUDGE_MODEL: "judge-test",
        REPLY_JUDGE_BASE_URL: "https://judge.example/v1",
        REPLY_JUDGE_API_KEY: "secret",
    });
    snapshots.replace(judgeConfig);
    assert.equal(snapshots.get().appConfig.frontMode, "judge");
    assert.equal(inFlight.appConfig.frontMode, "legacy", "captured requests retain the old Front policy snapshot");

    snapshots.replace(loadAppConfig({ FRONT_MODE: "legacy", AI_PROVIDER: "gpt" }));
    assert.equal(snapshots.get().appConfig.frontMode, "legacy");
});

test("Reply Judge model and timeout hot reload for new captures while in-flight captures stay unchanged", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tenbot-reply-judge-config-"));
    const envPath = join(directory, ".env");
    const tempPath = join(directory, ".env.next");
    try {
        await writeFile(envPath, [
            "FRONT_MODE=judge",
            "AI_PROVIDER=gpt",
            "REPLY_JUDGE_PROVIDER=openai-compatible",
            "REPLY_JUDGE_MODEL=model-a",
            "REPLY_JUDGE_BASE_URL=https://judge.example/v1",
            "REPLY_JUDGE_API_KEY=test-secret",
            "REPLY_JUDGE_TIMEOUT_MS=5000",
            "REPLY_JUDGE_IPO_FALLBACK_TO_MAIN=false",
            "REPLY_JUDGE_TURN_WAIT_MS=20000",
            "CODEX_MODEL=main-model",
        ].join("\n") + "\n", "utf8");
        const configStore = createConfigStore({ envPath, environment: {} });
        const snapshots = new RuntimeConfigSnapshotStore(configStore.getAppConfig(), (config) => fakePlugin(config.ai.provider, config.ai.gpt.model), () => undefined);
        const captureReplyJudge = () => snapshots.get().appConfig.replyJudge;
        const inFlightConfig = captureReplyJudge();

        const modelUpdate = await configStore.updatePublicConfig({ field: "replyJudge.model", value: "model-b" });
        const timeoutUpdate = await configStore.updatePublicConfig({ field: "replyJudge.timeoutMs", value: 15_000 });
        const fallbackUpdate = await configStore.updatePublicConfig({ field: "replyJudge.fallbackToMainOnInvalidOutput", value: true });
        const turnWaitUpdate = await configStore.updatePublicConfig({ field: "replyJudge.turnWaitMs", value: 25_000 });
        assert.equal(modelUpdate.ok, true);
        assert.equal(timeoutUpdate.ok, true);
        assert.equal(fallbackUpdate.ok, true);
        assert.equal(turnWaitUpdate.ok, true);
        if (modelUpdate.ok) assert.equal(modelUpdate.requiresRestart, false);
        if (timeoutUpdate.ok) assert.equal(timeoutUpdate.requiresRestart, false);
        if (fallbackUpdate.ok) assert.equal(fallbackUpdate.requiresRestart, false);
        if (turnWaitUpdate.ok) assert.equal(turnWaitUpdate.requiresRestart, false);
        const tuiUpdate = snapshots.replace(configStore.getAppConfig());
        assert.equal(tuiUpdate.revision, 2);
        assert.equal(captureReplyJudge().model, "model-b");
        assert.equal(captureReplyJudge().timeoutMs, 15_000);
        assert.equal(captureReplyJudge().fallbackToMainOnInvalidOutput, true);
        assert.equal(captureReplyJudge().turnWaitMs, 25_000);

        const externalEnv = (await readFile(envPath, "utf8"))
            .replace("REPLY_JUDGE_MODEL=model-b", "REPLY_JUDGE_MODEL=model-c")
            .replace("REPLY_JUDGE_TIMEOUT_MS=15000", "REPLY_JUDGE_TIMEOUT_MS=20000")
            .replace("REPLY_JUDGE_IPO_FALLBACK_TO_MAIN=true", "REPLY_JUDGE_IPO_FALLBACK_TO_MAIN=false")
            .replace("REPLY_JUDGE_TURN_WAIT_MS=25000", "REPLY_JUDGE_TURN_WAIT_MS=30000");
        const watcher = new FileChangeWatcher(envPath, async () => {
            snapshots.replace(configStore.getAppConfig());
        }, 35);
        const waitFor = async (predicate: () => boolean) => {
            const started = Date.now();
            while (!predicate()) {
                if (Date.now() - started > 2_000) throw new Error("Reply Judge env reload timed out");
                await new Promise((resolve) => setTimeout(resolve, 5));
            }
        };
        try {
            await watcher.start();
            await writeFile(tempPath, externalEnv, "utf8");
            await rename(tempPath, envPath);
            await waitFor(() => snapshots.get().revision === 3);
        } finally {
            watcher.close();
        }
        const externalUpdate = snapshots.get();
        assert.equal(externalUpdate.revision, 3);
        assert.equal(captureReplyJudge().model, "model-c");
        assert.equal(captureReplyJudge().timeoutMs, 20_000);
        assert.equal(captureReplyJudge().fallbackToMainOnInvalidOutput, false);
        assert.equal(captureReplyJudge().turnWaitMs, 30_000);
        assert.equal(externalUpdate.model.id, "gpt");
        assert.equal(externalUpdate.model.model, "main-model");
        assert.equal(inFlightConfig.model, "model-a");
        assert.equal(inFlightConfig.timeoutMs, 5_000);
        assert.equal(inFlightConfig.fallbackToMainOnInvalidOutput, false);
        assert.equal(inFlightConfig.turnWaitMs, 20_000);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
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
