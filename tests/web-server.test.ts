import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTenBotWebServer } from "../src/control/web-server.js";
import type { TenBotControl } from "../src/control/tenbot-control.js";
import type { RuntimeStatus } from "../src/control/runtime-status.js";
import type { RuntimeEvent } from "../src/control/runtime-event.js";
import type { LogEntry } from "../src/shared/logger.js";
import { toPublicConfig } from "../src/config/config-validation.js";
import type { ConversationItem, ConversationSummary } from "../src/control/conversation-timeline.js";
import type { AutomatedPeerSummary } from "../src/control/automated-peers.js";
import type { KnownMemberSummary } from "../src/control/known-members.js";
import { loadAppConfig } from "../src/config/config-validation.js";
import type { ConfigUpdateResult, PublicConfigPatch } from "../src/config/config-types.js";

const initialStatus: RuntimeStatus = {
    qq: "connected",
    provider: { id: "gpt", model: "gpt-test", webSearch: false, configured: true },
    activeCycles: 1,
    contextConversations: 1,
    memes: { count: 1, revision: 1, loadedAt: "2026-01-01T00:00:00.000Z" },
    prompt: { provider: "gpt", revision: 1, loadedAt: "2026-01-01T00:00:00.000Z" },
    shuttingDown: false,
};

function createFakeControl() {
    let status = structuredClone(initialStatus);
    const conversationId = "thread/one";
    const conversations: ConversationSummary[] = [{
        conversationId,
        kind: "group",
        label: "群 1234ABCD",
        lastActivityAt: "2026-01-01T00:00:00.000Z",
    }];
    const timeline: ConversationItem[] = [{
        id: "message-1",
        type: "peer-message",
        displayName: "成员",
        content: "你好",
        timestamp: "2026-01-01T00:00:00.000Z",
    }];
    const publicConfig = toPublicConfig(loadAppConfig({
        QQBOT_APP_ID: "private-qq-app-id",
        QQBOT_APP_SECRET: "private-qq-app-secret",
        CODEX_API_KEY: "private-main-model-key",
        CODEX_BASE_URL: "https://private-model.example/v1",
        REPLY_JUDGE_API_KEY: "private-judge-key",
        DEEPSEEK_API_KEY: "private-deepseek-key",
    }));
    const registered: AutomatedPeerSummary[] = [{
        id: "stable-peer-id",
        displayId: "stable",
        displayName: "已登记账号",
        platformBotHint: true,
    }];
    const recent: AutomatedPeerSummary[] = [{
        id: "recent-peer-id",
        displayId: "recent",
        displayName: "最近账号",
        platformBotHint: false,
    }];
    const members: KnownMemberSummary[] = [{
        id: "opaque-member-id",
        displayId: "A1B2C3D4",
        displayName: "群友",
        lastSeenAt: 1,
        groupCount: 1,
    }];
    const statusListeners = new Set<(value: RuntimeStatus) => void>();
    const logListeners = new Set<(value: LogEntry) => void>();
    const eventListeners = new Set<(value: RuntimeEvent) => void>();
    const patchCalls: PublicConfigPatch[] = [];
    let updateResult: ConfigUpdateResult = { ok: true, requiresRestart: false, changedFields: [], message: "saved" };

    const control = {
        getStatus: () => structuredClone(status),
        getConfig: () => structuredClone(publicConfig),
        async updateConfig(patch: PublicConfigPatch) {
            patchCalls.push(patch);
            return updateResult;
        },
        getConversations: () => structuredClone(conversations),
        getConversationTimeline: (id: string) => id === conversationId ? structuredClone(timeline) : [],
        getAutomatedPeers: () => structuredClone(registered),
        getRecentPeers: () => structuredClone(recent),
        async getKnownMembers() { return structuredClone(members); },
        subscribeStatus(listener: (value: RuntimeStatus) => void) {
            statusListeners.add(listener);
            listener(structuredClone(status));
            return () => statusListeners.delete(listener);
        },
        subscribeLogs(listener: (value: LogEntry) => void) {
            logListeners.add(listener);
            return () => logListeners.delete(listener);
        },
        subscribeEvents(listener: (value: RuntimeEvent) => void) {
            eventListeners.add(listener);
            return () => eventListeners.delete(listener);
        },
    } as unknown as TenBotControl;

    return {
        control,
        conversationId,
        updateStatus(next: RuntimeStatus) {
            status = structuredClone(next);
            for (const listener of statusListeners) listener(structuredClone(status));
        },
        publishLog(entry: LogEntry) {
            for (const listener of logListeners) listener(entry);
        },
        publishEvent(event: RuntimeEvent) {
            for (const listener of eventListeners) listener(event);
        },
        listenerCounts() {
            return { status: statusListeners.size, logs: logListeners.size, events: eventListeners.size };
        },
        patchCalls,
        setUpdateResult(result: ConfigUpdateResult) { updateResult = result; },
    };
}

async function startServer(control: TenBotControl, staticDirectory?: string) {
    const server = createTenBotWebServer(control, { host: "127.0.0.1", port: 0, staticDirectory });
    const address = await server.start();
    return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

test("HTTP API reads through TenBotControl and keeps config secrets out of responses", async () => {
    const fake = createFakeControl();
    const { server, baseUrl } = await startServer(fake.control);
    try {
        const health = await fetch(`${baseUrl}/api/health`);
        assert.equal(health.status, 200);
        assert.deepEqual(await health.json(), { ok: true, qq: "connected", shuttingDown: false });

        const status = await fetch(`${baseUrl}/api/status`);
        assert.deepEqual(await status.json(), initialStatus);

        const configResponse = await fetch(`${baseUrl}/api/config`);
        const configText = await configResponse.text();
        assert.equal(configResponse.status, 200);
        assert.doesNotMatch(configText, /private-qq-app-id|private-qq-app-secret|private-main-model-key|private-judge-key|private-deepseek-key|private-model\.example/);
        assert.doesNotMatch(configText, /"appSecret"|"apiKey"|"baseURL"/);

        const conversations = await fetch(`${baseUrl}/api/conversations`);
        assert.deepEqual(await conversations.json(), [{
            conversationId: fake.conversationId,
            kind: "group",
            label: "群 1234ABCD",
            lastActivityAt: "2026-01-01T00:00:00.000Z",
        }]);

        const timeline = await fetch(`${baseUrl}/api/conversations/${encodeURIComponent(fake.conversationId)}`);
        assert.deepEqual(await timeline.json(), [{
            id: "message-1",
            type: "peer-message",
            displayName: "成员",
            content: "你好",
            timestamp: "2026-01-01T00:00:00.000Z",
        }]);

        const missing = await fetch(`${baseUrl}/api/conversations/missing`);
        assert.equal(missing.status, 404);
        assert.deepEqual(await missing.json(), { error: { message: "Not found" } });

        const peers = await fetch(`${baseUrl}/api/automated-peers`);
        assert.deepEqual(await peers.json(), {
            registered: [{ id: "stable-peer-id", displayId: "stable", displayName: "已登记账号", platformBotHint: true }],
            recent: [{ id: "recent-peer-id", displayId: "recent", displayName: "最近账号", platformBotHint: false }],
        });

        const members = await fetch(`${baseUrl}/api/known-members`);
        assert.deepEqual(await members.json(), [{
            id: "opaque-member-id", displayId: "A1B2C3D4", displayName: "群友", lastSeenAt: 1, groupCount: 1,
        }]);

        assert.equal(configResponse.headers.get("access-control-allow-origin"), null);
        const methodNotAllowed = await fetch(`${baseUrl}/api/status`, { method: "POST" });
        assert.equal(methodNotAllowed.status, 405);
        assert.deepEqual(await methodNotAllowed.json(), { error: { message: "Method not allowed" } });
    } finally {
        await server.close();
    }
});

test("PATCH /api/config validates allowlisted patches and delegates updates through TenBotControl", async () => {
    const fake = createFakeControl();
    const { server, baseUrl } = await startServer(fake.control);
    try {
        const response = await fetch(`${baseUrl}/api/config`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ field: "replyJudge.model", value: "judge-next" }),
        });
        assert.equal(response.status, 200);
        const payload = await response.json() as { result: ConfigUpdateResult; config: unknown };
        assert.deepEqual(payload.result, { ok: true, requiresRestart: false, changedFields: [], message: "saved" });
        assert.deepEqual(fake.patchCalls, [{ field: "replyJudge.model", value: "judge-next" }]);
        const responseText = JSON.stringify(payload);
        assert.doesNotMatch(responseText, /private-qq-app-secret|private-main-model-key|private-judge-key|private-deepseek-key|private-model\.example/);
    } finally {
        await server.close();
    }
});

test("PATCH /api/config rejects secret fields and semantically invalid values before calling Control", async () => {
    const fake = createFakeControl();
    const { server, baseUrl } = await startServer(fake.control);
    try {
        const unsupported = await fetch(`${baseUrl}/api/config`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ field: "REPLY_JUDGE_API_KEY", value: "never-accept-this" }),
        });
        assert.equal(unsupported.status, 400);
        assert.deepEqual(await unsupported.json(), { error: { message: "Unsupported configuration patch" } });

        const invalid = await fetch(`${baseUrl}/api/config`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ field: "replyJudge.timeoutMs", value: 30.5 }),
        });
        assert.equal(invalid.status, 400);

        const wrongType = await fetch(`${baseUrl}/api/config`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ field: "replyJudge.timeoutMs", value: "15000" }),
        });
        assert.equal(wrongType.status, 400);
        assert.deepEqual(fake.patchCalls, []);
    } finally {
        await server.close();
    }
});

test("PATCH /api/config reports save failure without exposing backend details", async () => {
    const fake = createFakeControl();
    fake.setUpdateResult({ ok: false, requiresRestart: false, changedFields: [], message: "save failed", details: "private-main-model-key" });
    const { server, baseUrl } = await startServer(fake.control);
    try {
        const response = await fetch(`${baseUrl}/api/config`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ field: "logLevel", value: "debug" }),
        });
        assert.equal(response.status, 500);
        const body = await response.text();
        assert.match(body, /Unable to save configuration/);
        assert.doesNotMatch(body, /private-main-model-key/);
        assert.deepEqual(fake.patchCalls, [{ field: "logLevel", value: "debug" }]);
    } finally {
        await server.close();
    }
});

interface SseEvent {
    type: string;
    data: unknown;
}

function collectSse(response: Response) {
    assert.ok(response.body);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const events: SseEvent[] = [];
    const waiters = new Map<string, Array<(event: SseEvent) => void>>();

    const deliver = (event: SseEvent) => {
        const waiter = waiters.get(event.type)?.shift();
        if (waiter) waiter(event);
        else events.push(event);
    };
    const waitFor = (type: string): Promise<SseEvent> => {
        const existing = events.findIndex((event) => event.type === type);
        if (existing >= 0) return Promise.resolve(events.splice(existing, 1)[0]!);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`Timed out waiting for SSE event ${type}`)), 3_000);
            const wrapped = (event: SseEvent) => { clearTimeout(timer); resolve(event); };
            waiters.set(type, [...(waiters.get(type) ?? []), wrapped]);
        });
    };

    void (async () => {
        let pending = "";
        try {
            while (true) {
                const next = await reader.read();
                if (next.done) break;
                pending += decoder.decode(next.value, { stream: true });
                const blocks = pending.split(/\r?\n\r?\n/);
                pending = blocks.pop() ?? "";
                for (const block of blocks) {
                    const lines = block.split(/\r?\n/);
                    const type = lines.find((line) => line.startsWith("event: "))?.slice(7);
                    const data = lines.filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
                    if (type && data) deliver({ type, data: JSON.parse(data) as unknown });
                }
            }
        } catch { /* Cancellation ends the stream reader. */ }
    })();

    return { waitFor, cancel: () => reader.cancel() };
}

async function waitFor(predicate: () => boolean): Promise<void> {
    const startedAt = Date.now();
    while (!predicate()) {
        if (Date.now() - startedAt > 2_000) throw new Error("Timed out waiting for listener cleanup");
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

test("SSE sends current status and live status, log, and runtime events; disconnect cleans subscriptions", async () => {
    const fake = createFakeControl();
    const { server, baseUrl } = await startServer(fake.control);
    const firstResponse = await fetch(`${baseUrl}/api/events`);
    const first = collectSse(firstResponse);
    assert.deepEqual((await first.waitFor("status")).data, initialStatus);

    const secondResponse = await fetch(`${baseUrl}/api/events`);
    const second = collectSse(secondResponse);
    assert.deepEqual((await second.waitFor("status")).data, initialStatus);
    assert.deepEqual(fake.listenerCounts(), { status: 2, logs: 2, events: 2 });

    await first.cancel();
    await waitFor(() => fake.listenerCounts().status === 1 && fake.listenerCounts().logs === 1 && fake.listenerCounts().events === 1);

    const updatedStatus = { ...initialStatus, activeCycles: 2 };
    const nextStatus = second.waitFor("status");
    fake.updateStatus(updatedStatus);
    assert.deepEqual((await nextStatus).data, updatedStatus);

    const log: LogEntry = { level: "info", timestamp: "12:00:00", text: "web test log" };
    const nextLog = second.waitFor("log");
    fake.publishLog(log);
    assert.deepEqual((await nextLog).data, log);

    const runtimeEvent: RuntimeEvent = { type: "recent-peers-updated" };
    const nextRuntimeEvent = second.waitFor("runtime-event");
    fake.publishEvent(runtimeEvent);
    assert.deepEqual((await nextRuntimeEvent).data, runtimeEvent);

    await second.cancel();
    await waitFor(() => Object.values(fake.listenerCounts()).every((count) => count === 0));
    await server.close();
    await assert.rejects(fetch(`${baseUrl}/api/health`));
});

test("a busy configured port fails clearly without selecting another port", async () => {
    const fake = createFakeControl();
    const first = createTenBotWebServer(fake.control, { host: "127.0.0.1", port: 0 });
    const address = await first.start();
    const second = createTenBotWebServer(fake.control, { host: "127.0.0.1", port: address.port });
    try {
        await assert.rejects(second.start(), /EADDRINUSE|address already in use/i);
    } finally {
        await second.close();
        await first.close();
    }
});

test("production static server returns the app entry, serves assets, and falls back for client routes", async () => {
    const fake = createFakeControl();
    const staticDirectory = await mkdtemp(join(tmpdir(), "tenbot-web-ui-"));
    await mkdir(join(staticDirectory, "assets"));
    await writeFile(join(staticDirectory, "index.html"), "<!doctype html><title>TenBot Web Control</title>");
    await writeFile(join(staticDirectory, "assets", "app.js"), "console.log('web-ui');");
    const { server, baseUrl } = await startServer(fake.control, staticDirectory);
    try {
        const root = await fetch(`${baseUrl}/`);
        assert.equal(root.status, 200);
        assert.match(await root.text(), /TenBot Web Control/);
        assert.match(root.headers.get("content-type") ?? "", /text\/html/);

        const route = await fetch(`${baseUrl}/settings`);
        assert.equal(route.status, 200);
        assert.match(await route.text(), /TenBot Web Control/);

        const asset = await fetch(`${baseUrl}/assets/app.js`);
        assert.equal(asset.status, 200);
        assert.match(asset.headers.get("content-type") ?? "", /javascript/);
        assert.match(await asset.text(), /web-ui/);

        const missingAsset = await fetch(`${baseUrl}/assets/missing.js`);
        assert.equal(missingAsset.status, 404);
    } finally {
        await server.close();
        await rm(staticDirectory, { recursive: true, force: true });
    }
});
