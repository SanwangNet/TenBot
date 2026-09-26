import assert from "node:assert/strict";
import test from "node:test";
import { createServer as createHttpServer } from "node:http";
import { createServer as createViteServer } from "vite";
import { ApiError, parseJsonResponse } from "../web/src/api/client.js";
import { parseEventData } from "../web/src/api/events.js";
import type { PublicConfig, RuntimeStatus } from "../web/src/api/types.js";
import { initialRuntimeState, runtimeReducer } from "../web/src/runtime/runtime-state.js";
import {
    createSettingsForm,
    dirtySettingsFields,
    visibleDirtySettingsFields,
    parseTimeoutInput,
    parseTurnWaitSecondsInput,
    settingsFormReducer,
    settingsPatches,
} from "../web/src/settings/settings-state.js";
import { filterLogs, initialLogViewState, logViewReducer, MAX_WEB_LOG_ENTRIES } from "../web/src/components/log-state.js";
import type { LogEntry } from "../web/src/api/types.js";
import { conversationReducer, initialConversationViewState } from "../web/src/conversations/conversation-state.js";
import { addNotice, isProminentProviderError } from "../web/src/ui/feedback-state.js";
import { createEditorDraft, editDraft, isEditorDirty } from "../web/src/editor/editor-state.js";
import { nextPage } from "../web/src/navigation.js";

const status: RuntimeStatus = {
    qq: "connected",
    groupRepliesEnabled: true,
    provider: { id: "gpt", model: "gpt-test", webSearch: true, configured: true },
    activeCycles: 1,
    contextConversations: 3,
    hotReload: {
        enabled: true,
        revision: 4,
        loadedAt: "2026-01-01T00:00:00.000Z",
        lastSuccessAt: "2026-01-01T00:00:00.000Z",
        requiresRestart: false,
    },
    memes: { count: 12, revision: 2, loadedAt: "2026-01-01T00:00:00.000Z" },
    prompt: { provider: "gpt", revision: 3, loadedAt: "2026-01-01T00:00:00.000Z", characters: 100, lines: 8 },
    shuttingDown: false,
};

const config: PublicConfig = {
    aiProvider: "gpt",
    replyJudge: { model: "judge", timeoutMs: 5000, fallbackToMainOnInvalidOutput: true, turnWaitMs: 20_000 },
    gpt: { model: "gpt-test", reasoningEffort: "high", verbosity: "high", configured: true },
    deepseek: { model: "deepseek-test", reasoningEffort: "high", configured: false },
    logLevel: "info",
    botLoopGuard: { maxCycles: 4, automatedPeerCount: 0 },
};

test("API JSON response parser returns successful payloads and reports safe HTTP or JSON errors", () => {
    assert.deepEqual(parseJsonResponse<{ ok: boolean }>(200, "{\"ok\":true}"), { ok: true });
    assert.throws(() => parseJsonResponse(404, "{\"error\":{\"message\":\"Not found\"}}"), (error: unknown) =>
        error instanceof ApiError && error.status === 404 && error.message === "Not found");
    assert.throws(() => parseJsonResponse(200, "not json"), /invalid JSON/i);
});

test("SSE message parser decodes JSON and rejects malformed frames", () => {
    assert.deepEqual(parseEventData<{ activeCycles: number }>("{\"activeCycles\":2}"), { activeCycles: 2 });
    assert.throws(() => parseEventData("{"), SyntaxError);
});

test("Runtime reducer preserves live status over bootstrap and tracks connection and event time", () => {
    const liveStatus = { ...status, activeCycles: 2 };
    const withLiveStatus = runtimeReducer(initialRuntimeState, { type: "status", status: liveStatus });
    const bootstrapped = runtimeReducer(withLiveStatus, { type: "bootstrap-success", status, config });
    assert.equal(bootstrapped.status?.activeCycles, 2);
    assert.equal(bootstrapped.config, config);
    assert.equal(bootstrapped.loading, false);

    const online = runtimeReducer(bootstrapped, { type: "connection", connection: "online" });
    const recent = runtimeReducer(online, {
        type: "runtime-event",
        event: { type: "recent-peers-updated" },
        receivedAt: "2026-03-01T12:00:00.000Z",
    });
    assert.equal(recent.connection, "online");
    assert.equal(recent.lastRuntimeEventAt, "2026-03-01T12:00:00.000Z");
});

test("settings form calculates dirty fields and serializable patches with numeric conversion", () => {
    let form = createSettingsForm(config);
    form = settingsFormReducer(form, { type: "edit", field: "replyJudge.timeoutMs", value: "15000" })!;
    form = settingsFormReducer(form, { type: "edit", field: "aiProvider", value: "deepseek" })!;
    assert.deepEqual(dirtySettingsFields(form), ["aiProvider", "replyJudge.timeoutMs"]);
    assert.deepEqual(settingsPatches(form), [
        { field: "aiProvider", value: "deepseek" },
        { field: "replyJudge.timeoutMs", value: 15000 },
    ]);
    assert.equal(parseTimeoutInput("15000"), 15000);
    assert.equal(parseTimeoutInput("999"), null);
    assert.equal(parseTimeoutInput("1500.5"), null);
});

test("settings fallback toggle starts from server config, produces one boolean patch, and cleans after save", () => {
    let form = createSettingsForm(config);
    assert.equal(form.values["replyJudge.fallbackToMainOnInvalidOutput"], true);
    form = settingsFormReducer(form, { type: "edit", field: "replyJudge.fallbackToMainOnInvalidOutput", value: false })!;
    assert.deepEqual(dirtySettingsFields(form), ["replyJudge.fallbackToMainOnInvalidOutput"]);
    assert.deepEqual(settingsPatches(form), [{ field: "replyJudge.fallbackToMainOnInvalidOutput", value: false }]);

    const savedConfig: PublicConfig = {
        ...config,
        replyJudge: { ...config.replyJudge, fallbackToMainOnInvalidOutput: false },
    };
    form = settingsFormReducer(form, { type: "saved", config: savedConfig, field: "replyJudge.fallbackToMainOnInvalidOutput" })!;
    assert.equal(form.values["replyJudge.fallbackToMainOnInvalidOutput"], false);
    assert.deepEqual(dirtySettingsFields(form), []);
});

test("settings turn wait is edited in seconds and saved as validated milliseconds", () => {
    let form = createSettingsForm(config);
    assert.equal(form.values["replyJudge.turnWaitMs"], "20");
    form = settingsFormReducer(form, { type: "edit", field: "replyJudge.turnWaitMs", value: "12.5" })!;
    assert.deepEqual(dirtySettingsFields(form), ["replyJudge.turnWaitMs"]);
    assert.deepEqual(settingsPatches(form), [{ field: "replyJudge.turnWaitMs", value: 12_500 }]);
    assert.equal(parseTurnWaitSecondsInput("1"), 1_000);
    assert.equal(parseTurnWaitSecondsInput("60"), 60_000);
    assert.equal(parseTurnWaitSecondsInput("0"), null);
    assert.equal(parseTurnWaitSecondsInput("60.001"), null);
    assert.equal(parseTurnWaitSecondsInput("1.0001"), null);

    const savedConfig: PublicConfig = {
        ...config,
        replyJudge: { ...config.replyJudge, turnWaitMs: 12_500 },
    };
    form = settingsFormReducer(form, { type: "saved", config: savedConfig, field: "replyJudge.turnWaitMs" })!;
    assert.equal(form.values["replyJudge.turnWaitMs"], "12.5");
    assert.deepEqual(dirtySettingsFields(form), []);
});

test("settings external refresh reloads clean forms and preserves dirty edits with a conflict notice", () => {
    const changedConfig: PublicConfig = { ...config, replyJudge: { ...config.replyJudge, model: "external-judge" } };
    const clean = settingsFormReducer(createSettingsForm(config), { type: "server-refresh", config: changedConfig });
    assert.equal(clean?.baseline.replyJudge.model, "external-judge");
    assert.equal(clean?.values["replyJudge.model"], "external-judge");

    let dirty = settingsFormReducer(createSettingsForm(config), { type: "edit", field: "replyJudge.model", value: "my-unsaved-model" })!;
    dirty = settingsFormReducer(dirty, { type: "server-refresh", config: changedConfig })!;
    assert.equal(dirty.externalConflict, true);
    assert.equal(dirty.baseline.replyJudge.model, config.replyJudge.model);
    assert.equal(dirty.values["replyJudge.model"], "my-unsaved-model");
});

test("settings preset patches only selected provider while retaining hidden draft", () => {
    let form = createSettingsForm(config);
    form = settingsFormReducer(form, { type: "edit", field: "deepseek.model", value: "deepseek-custom" })!;
    form = settingsFormReducer(form, { type: "edit", field: "gpt.model", value: "gpt-custom" })!;
    assert.deepEqual(visibleDirtySettingsFields(form), ["gpt.model"]);
    assert.deepEqual(settingsPatches(form), [{ field: "gpt.model", value: "gpt-custom" }]);
    form = settingsFormReducer(form, { type: "edit", field: "aiProvider", value: "deepseek" })!;
    assert.deepEqual(visibleDirtySettingsFields(form), ["aiProvider", "deepseek.model"]);
    assert.deepEqual(settingsPatches(form), [{ field: "aiProvider", value: "deepseek" }, { field: "deepseek.model", value: "deepseek-custom" }]);
});

test("editor dirty state and navigation guard preserve unsaved content", () => {
    const resource = { id: "prompt:gpt" as const, displayName: "GPT", language: "markdown" as const, content: "Original", version: "v1" };
    const draft = createEditorDraft(resource);
    assert.equal(isEditorDirty(draft), false);
    assert.equal(isEditorDirty(editDraft(draft, "Edited")), true);
    assert.equal(nextPage("prompts", "models", true, false), "prompts");
    assert.equal(nextPage("prompts", "models", true, true), "models");
});

test("conversation reducer merges live messages and attempt transitions without stale timeline overwrite", () => {
    const start = conversationReducer(initialConversationViewState, { type: "event", event: { type: "conversation-item", conversationId: "id-1", kind: "group", label: "Group", item: { id: "m1", type: "peer-message", displayName: "Member", content: "hello", timestamp: "t1" } } });
    assert.equal(start.summaries[0]?.label, "Group");
    const loaded = conversationReducer(start, { type: "timeline", id: "id-1", items: [{ id: "m1", type: "peer-message", displayName: "Member", content: "hello", timestamp: "t1" }], atRevision: start.revision });
    const attempt = { id: "a1", type: "ai-attempt" as const, attemptId: "a1", cycleId: "c1", status: "generating" as const, timestamp: "t2" };
    const generating = conversationReducer(loaded, { type: "event", event: { type: "conversation-item", conversationId: "id-1", kind: "group", label: "Group", item: attempt } });
    assert.equal(generating.timelines["id-1"]?.length, 2);
    const failed = conversationReducer(generating, { type: "event", event: { type: "conversation-item", conversationId: "id-1", kind: "group", label: "Group", item: { ...attempt, status: "failed", timestamp: "t3" } } });
    assert.equal(failed.timelines["id-1"]?.length, 2);
    assert.equal(failed.timelines["id-1"]?.[1]?.type, "ai-attempt");
    const completed = conversationReducer(failed, { type: "event", event: { type: "conversation-item", conversationId: "id-1", kind: "group", label: "Group", item: { ...attempt, status: "completed", timestamp: "t4" } } });
    assert.equal(completed.timelines["id-1"]?.length, 1);
    assert.equal(conversationReducer(failed, { type: "timeline", id: "id-1", items: [], atRevision: 0 }), failed);
});

test("provider error Class C stays quiet and duplicate A/B notice aggregates", () => {
    const notice = { provider: "gpt", model: "gpt-test", tenbotCode: "R:A_MP_PSU", message: "safe", timestamp: "now" };
    assert.equal(isProminentProviderError(notice), true);
    assert.equal(isProminentProviderError({ ...notice, tenbotCode: "M:C_NS_NRL" }), false);
    const once = addNotice([], { id: 1, tone: "error", message: "safe", count: 1, details: notice });
    const twice = addNotice(once, { id: 2, tone: "error", message: "safe", count: 1, details: notice });
    assert.equal(twice.length, 1);
    assert.equal(twice[0]?.count, 2);
});

test("log reducer bounds the browser buffer, keeps append order, and clears only local entries", () => {
    let state = initialLogViewState;
    for (let index = 0; index <= MAX_WEB_LOG_ENTRIES; index++) {
        state = logViewReducer(state, { type: "append", entry: { timestamp: String(index), level: "info", text: `line ${index}` } });
    }
    assert.equal(state.entries.length, MAX_WEB_LOG_ENTRIES);
    assert.equal(state.entries[0]?.text, "line 1");
    assert.equal(state.entries.at(-1)?.text, `line ${MAX_WEB_LOG_ENTRIES}`);
    const cleared = logViewReducer(state, { type: "clear" });
    assert.deepEqual(cleared.entries, []);
    assert.equal(state.entries.length, MAX_WEB_LOG_ENTRIES);
});

test("log filtering matches level and case-insensitive text; follow state counts unseen rows", () => {
    const entries: LogEntry[] = [
        { timestamp: "1", level: "debug", text: "Loading Config" },
        { timestamp: "2", level: "error", text: "Model FAILED" },
        { timestamp: "3", level: "info", text: "Runtime ready" },
    ];
    assert.deepEqual(filterLogs(entries, "error", "failed"), [entries[1]]);
    assert.deepEqual(filterLogs(entries, "all", "CONFIG"), [entries[0]]);

    let state = logViewReducer(initialLogViewState, { type: "set-follow", follow: false });
    state = logViewReducer(state, { type: "append", entry: entries[0]! });
    assert.equal(state.follow, false);
    assert.equal(state.unseenCount, 1);
    state = logViewReducer(state, { type: "scroll-position", atBottom: true });
    assert.equal(state.follow, true);
    assert.equal(state.unseenCount, 0);
});

test("Vite API proxy streams SSE frames from the backend", async () => {
    const backend = createHttpServer((_request, response) => {
        response.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache",
        });
        response.flushHeaders();
        response.write('event: status\ndata: {"source":"proxy-ok"}\n\n');
    });
    await new Promise<void>((resolve, reject) => {
        backend.once("error", reject);
        backend.listen(0, "127.0.0.1", () => { backend.off("error", reject); resolve(); });
    });

    const backendAddress = backend.address();
    assert.ok(backendAddress && typeof backendAddress === "object");
    const vite = await createViteServer({
        configFile: false,
        root: "web",
        logLevel: "silent",
        server: {
            host: "127.0.0.1",
            port: 0,
            strictPort: false,
            proxy: {
                "/api": { target: `http://127.0.0.1:${backendAddress.port}`, changeOrigin: false },
            },
        },
    });
    const abortController = new AbortController();
    try {
        await vite.listen();
        const viteAddress = vite.httpServer?.address();
        assert.ok(viteAddress && typeof viteAddress === "object");
        const response = await fetch(`http://127.0.0.1:${viteAddress.port}/api/events`, { signal: abortController.signal });
        assert.equal(response.status, 200);
        assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
        assert.ok(response.body);
        const reader = response.body.getReader();
        const firstChunk = await reader.read();
        assert.ok(firstChunk.value);
        const frame = new TextDecoder().decode(firstChunk.value);
        assert.match(frame, /event: status/);
        assert.match(frame, /proxy-ok/);
        await reader.cancel();
    } finally {
        abortController.abort();
        await vite.close();
        await new Promise<void>((resolve) => backend.close(() => resolve()));
    }
});
