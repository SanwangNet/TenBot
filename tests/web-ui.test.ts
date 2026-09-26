import assert from "node:assert/strict";
import test from "node:test";
import { createServer as createHttpServer } from "node:http";
import { createServer as createViteServer } from "vite";
import { ApiError, parseJsonResponse } from "../web/src/api/client.js";
import { parseEventData } from "../web/src/api/events.js";
import type { PublicConfig, RuntimeStatus } from "../web/src/api/types.js";
import { initialRuntimeState, runtimeReducer } from "../web/src/runtime/runtime-state.js";

const status: RuntimeStatus = {
    qq: "connected",
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
    replyJudge: { model: "judge", timeoutMs: 5000 },
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
