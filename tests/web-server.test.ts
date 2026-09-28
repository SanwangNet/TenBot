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
import type { EditorResourceId } from "../src/control/editor-resources.js";
import { MemeLibraryService } from "../src/skills/meme/library-service.js";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { WebSessionRepository } from "../src/auth/web-session-repository.js";
import { createTokenHash, OAUTH_STATE_COOKIE, WEB_SESSION_COOKIE, WEB_SESSION_TTL_MS, WebAuthService } from "../src/auth/web-auth-service.js";

const initialStatus: RuntimeStatus = {
    qq: "connected",
    groupRepliesEnabled: false,
    provider: { id: "gpt", model: "gpt-test", webSearch: false, configured: true },
    activeCycles: 1,
    contextConversations: 1,
    memes: { count: 1, revision: 1, loadedAt: "2026-01-01T00:00:00.000Z" },
    prompt: { provider: "gpt", revision: 1, loadedAt: "2026-01-01T00:00:00.000Z" },
    shuttingDown: false,
};

const authEnvironment = {
    GITHUB_OAUTH_CLIENT_ID: "test-client-id",
    GITHUB_OAUTH_CLIENT_SECRET: "test-client-secret",
    GITHUB_OAUTH_CALLBACK_URL: "http://127.0.0.1:3000/api/auth/github/callback",
    GITHUB_OAUTH_ALLOWED_USER_IDS: "12345678",
};
const authCookies = new Map<string, string>();

async function fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const existingCookie = authCookies.get(url.origin);
    if (!existingCookie) return globalThis.fetch(input, init);
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    headers.set("Cookie", existingCookie);
    if (["POST", "PUT", "PATCH", "DELETE"].includes((init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()) && !headers.has("Origin")) {
        headers.set("Origin", new URL(authEnvironment.GITHUB_OAUTH_CALLBACK_URL).origin);
    }
    return globalThis.fetch(input, { ...init, headers });
}

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
    let logReplay: LogEntry[] = [];
    const patchCalls: PublicConfigPatch[] = [];
    const peerCalls: string[] = [];
    const resourceCalls: string[] = [];
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
        async addAutomatedPeer(id: string) { peerCalls.push(`add:${id}`); return { ok: true, changed: true, message: "added" }; },
        async removeAutomatedPeer(id: string) { peerCalls.push(`remove:${id}`); return { ok: true, changed: true, message: "removed" }; },
        async getEditorResource(id: EditorResourceId) { resourceCalls.push(`get:${id}`); return { id, displayName: "Prompt", language: "markdown", content: "safe prompt", version: "a".repeat(64) }; },
        async saveEditorResource(id: EditorResourceId, content: string, expectedVersion: string) {
            resourceCalls.push(`save:${id}:${content}:${expectedVersion}`);
            if (expectedVersion === "b".repeat(64)) return { ok: false, reason: "conflict", message: "File changed on the server" };
            return { ok: true, resource: { id, displayName: "Prompt", language: "markdown", content, version: "c".repeat(64) }, reload: { ok: true, message: "reloaded", loadedAt: "now" } };
        },
        subscribeStatus(listener: (value: RuntimeStatus) => void) {
            statusListeners.add(listener);
            listener(structuredClone(status));
            return () => statusListeners.delete(listener);
        },
        subscribeLogs(listener: (value: LogEntry) => void) {
            logListeners.add(listener);
            for (const entry of logReplay) listener(structuredClone(entry));
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
        setLogReplay(entries: LogEntry[]) { logReplay = structuredClone(entries); },
        publishEvent(event: RuntimeEvent) {
            for (const listener of eventListeners) listener(event);
        },
        listenerCounts() {
            return { status: statusListeners.size, logs: logListeners.size, events: eventListeners.size };
        },
        patchCalls,
        peerCalls,
        resourceCalls,
        setUpdateResult(result: ConfigUpdateResult) { updateResult = result; },
    };
}

async function createAuthFixture(control: TenBotControl, options: {
    environment?: NodeJS.ProcessEnv;
    fetch?: typeof fetch;
    now?: () => number;
    staticDirectory?: string;
    memeService?: MemeLibraryService;
    seedSession?: boolean;
} = {}) {
    const directory = await mkdtemp(join(tmpdir(), "tenbot-web-auth-"));
    const repository = new WebSessionRepository(join(directory, "bot.db"));
    const rawToken = randomBytes(32).toString("base64url");
    const user = { id: "12345678", login: "test-admin", avatarUrl: "https://avatars.githubusercontent.com/u/12345678" };
    const now = options.now?.() ?? Date.now();
    if (options.seedSession !== false) repository.create(createTokenHash(rawToken), user, now, now + WEB_SESSION_TTL_MS);
    const auth = new WebAuthService(options.environment ?? authEnvironment, repository, { fetch: options.fetch, now: options.now });
    const web = createTenBotWebServer(control, {
        host: "127.0.0.1", port: 0,
        staticDirectory: options.staticDirectory,
        memeService: options.memeService,
        auth,
    });
    const address = await web.start();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    if (options.seedSession !== false) authCookies.set(baseUrl, `${WEB_SESSION_COOKIE}=${rawToken}`);
    return {
        server: {
            close: async () => {
                authCookies.delete(baseUrl);
                await web.close();
                repository.close();
                await rm(directory, { recursive: true, force: true });
            },
        },
        baseUrl,
        directory,
        repository,
        auth,
        rawToken,
        user,
    };
}

async function startServer(control: TenBotControl, staticDirectory?: string, memeService?: MemeLibraryService) {
    return createAuthFixture(control, { staticDirectory, memeService });
}

test("meme library API lists, uploads, previews, rejects duplicate names, and deletes only managed files", async () => {
    const fake = createFakeControl();
    const directory = await mkdtemp(join(tmpdir(), "tenbot-web-memes-"));
    const service = new MemeLibraryService(directory);
    const { server, baseUrl } = await startServer(fake.control, undefined, service);
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
    try {
        const empty = await fetch(`${baseUrl}/api/meme-library`);
        assert.deepEqual(await empty.json(), { files: [] });
        const upload = await fetch(`${baseUrl}/api/meme-library`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: "测试图", data: png.toString("base64") }),
        });
        assert.equal(upload.status, 201);
        assert.deepEqual(await upload.json(), { filename: "测试图.png" });
        const duplicate = await fetch(`${baseUrl}/api/meme-library`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: "测试图", data: png.toString("base64") }),
        });
        assert.equal(duplicate.status, 409);
        const preview = await fetch(`${baseUrl}/api/meme-library/${encodeURIComponent("测试图.png")}`);
        assert.equal(preview.status, 200);
        assert.equal(preview.headers.get("content-type"), "image/png");
        assert.deepEqual(Buffer.from(await preview.arrayBuffer()), png);
        assert.equal((await fetch(`${baseUrl}/api/meme-library/%2e%2e%2f.env`)).status, 404);
        const deleted = await fetch(`${baseUrl}/api/meme-library/${encodeURIComponent("测试图.png")}`, { method: "DELETE" });
        assert.equal(deleted.status, 200);
        assert.deepEqual(await (await fetch(`${baseUrl}/api/meme-library`)).json(), { files: [] });
    } finally {
        await server.close();
        await rm(directory, { recursive: true, force: true });
    }
});

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
        assert.doesNotMatch(configText, /"logLevel"|botTimeZone|BOT_TIME_ZONE/);

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

        const fallback = await fetch(`${baseUrl}/api/config`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ field: "replyJudge.fallbackToMainOnInvalidOutput", value: false }),
        });
        assert.equal(fallback.status, 200);
        assert.deepEqual(fake.patchCalls[1], { field: "replyJudge.fallbackToMainOnInvalidOutput", value: false });
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

        const invalidFallback = await fetch(`${baseUrl}/api/config`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ field: "replyJudge.fallbackToMainOnInvalidOutput", value: "true" }),
        });
        assert.equal(invalidFallback.status, 400);
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
            body: JSON.stringify({ field: "aiProvider", value: "deepseek" }),
        });
        assert.equal(response.status, 500);
        const body = await response.text();
        assert.match(body, /Unable to save configuration/);
        assert.doesNotMatch(body, /private-main-model-key/);
        assert.deepEqual(fake.patchCalls, [{ field: "aiProvider", value: "deepseek" }]);
    } finally {
        await server.close();
    }
});

test("PATCH /api/config rejects the removed logLevel field as unsupported", async () => {
    const fake = createFakeControl();
    const { server, baseUrl } = await startServer(fake.control);
    try {
        const response = await fetch(`${baseUrl}/api/config`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ field: "logLevel", value: "debug" }),
        });
        assert.equal(response.status, 400);
        assert.deepEqual(await response.json(), { error: { message: "Unsupported configuration patch" } });
        assert.deepEqual(fake.patchCalls, []);
    } finally {
        await server.close();
    }
});

test("PATCH /api/config rejects private BOT_TIME_ZONE", async () => {
    const fake = createFakeControl();
    const { server, baseUrl } = await startServer(fake.control);
    try {
        const response = await fetch(`${baseUrl}/api/config`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ field: "botTimeZone", value: "Asia/Tokyo" }),
        });
        assert.equal(response.status, 400);
        assert.deepEqual(await response.json(), { error: { message: "Unsupported configuration patch" } });
        assert.deepEqual(fake.patchCalls, []);
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

test("SSE reconnect sends a replacement snapshot with the existing repeatCount", async () => {
    const fake = createFakeControl();
    const canonical: LogEntry = { timestamp: "13:00:05", level: "all", text: "same event", rowId: "row-1", repeatCount: 10, firstTimestamp: "13:00:00" };
    fake.setLogReplay([canonical]);
    const { server, baseUrl } = await startServer(fake.control);
    try {
        const first = collectSse(await fetch(`${baseUrl}/api/events`));
        assert.deepEqual((await first.waitFor("logs-snapshot")).data, [canonical]);
        await first.cancel();
        await waitFor(() => fake.listenerCounts().logs === 0);

        const reconnected = collectSse(await fetch(`${baseUrl}/api/events`));
        assert.deepEqual((await reconnected.waitFor("logs-snapshot")).data, [canonical]);
        await reconnected.cancel();
        await waitFor(() => fake.listenerCounts().logs === 0);
    } finally {
        await server.close();
    }
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

test("automated peer mutation routes call TenBotControl", async () => {
    const fake = createFakeControl();
    const { server, baseUrl } = await startServer(fake.control);
    try {
        const added = await fetch(`${baseUrl}/api/automated-peers`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "recent-peer-id" }) });
        assert.equal(added.status, 200);
        assert.equal((await added.json() as { changed: boolean }).changed, true);
        const removed = await fetch(`${baseUrl}/api/automated-peers/${encodeURIComponent("stable-peer-id")}`, { method: "DELETE" });
        assert.equal(removed.status, 200);
        assert.deepEqual(fake.peerCalls, ["add:recent-peer-id", "remove:stable-peer-id"]);
        const invalid = await fetch(`${baseUrl}/api/automated-peers`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: 123 }) });
        assert.equal(invalid.status, 400);
    } finally { await server.close(); }
});

test("editor routes use allowlisted resource IDs and reject paths, secrets, and stale versions", async () => {
    const fake = createFakeControl();
    const { server, baseUrl } = await startServer(fake.control);
    try {
        const read = await fetch(`${baseUrl}/api/editor/resources/prompt%3Agpt`);
        assert.equal(read.status, 200);
        const body = await read.text();
        assert.match(body, /safe prompt/);
        assert.doesNotMatch(body, /appSecret|apiKey|baseURL|private-main-model-key/);
        for (const id of ["unknown", "..", "C:%5C.env", ".env", "prompt%3A%2E%2E%2F.env", "REPLY_JUDGE_API_KEY"]) {
            const result = await fetch(`${baseUrl}/api/editor/resources/${id}`);
            assert.equal(result.status, 404, id);
        }
        const saved = await fetch(`${baseUrl}/api/editor/resources/prompt%3Agpt`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "edited", expectedVersion: "a".repeat(64) }) });
        assert.equal(saved.status, 200);
        const conflict = await fetch(`${baseUrl}/api/editor/resources/prompt%3Agpt`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "edited", expectedVersion: "b".repeat(64) }) });
        assert.equal(conflict.status, 409);
        assert.deepEqual(fake.resourceCalls, [`get:prompt:gpt`, `save:prompt:gpt:edited:${"a".repeat(64)}`, `save:prompt:gpt:edited:${"b".repeat(64)}`]);
    } finally { await server.close(); }
});

function setCookieValue(headers: Headers, name: string): string {
    const value = headers.getSetCookie().find((item) => item.startsWith(`${name}=`));
    assert.ok(value, `missing ${name} cookie`);
    return value.split(";", 1)[0]!.slice(name.length + 1);
}

async function startOAuth(fixture: { baseUrl: string }) {
    const response = await globalThis.fetch(`${fixture.baseUrl}/api/auth/github`, { redirect: "manual" });
    assert.equal(response.status, 302);
    return { response, location: new URL(response.headers.get("location")!), stateCookie: setCookieValue(response.headers, OAUTH_STATE_COOKIE) };
}

function callbackRequest(baseUrl: string, stateCookie: string, query: string) {
    return globalThis.fetch(`${baseUrl}/api/auth/github/callback?${query}`, {
        redirect: "manual",
        headers: { Cookie: `${OAUTH_STATE_COOKIE}=${stateCookie}` },
    });
}

test("anonymous requests are locked out before API work or SSE subscription while health remains public", async () => {
    const fake = createFakeControl();
    const fixture = await createAuthFixture(fake.control, { seedSession: false });
    try {
        assert.equal((await globalThis.fetch(`${fixture.baseUrl}/api/status`)).status, 401);
        assert.equal((await globalThis.fetch(`${fixture.baseUrl}/api/config`)).status, 401);
        const events = await globalThis.fetch(`${fixture.baseUrl}/api/events`);
        assert.equal(events.status, 401);
        assert.doesNotMatch(events.headers.get("content-type") ?? "", /text\/event-stream/);
        assert.deepEqual(fake.listenerCounts(), { status: 0, logs: 0, events: 0 });
        const health = await globalThis.fetch(`${fixture.baseUrl}/api/health`);
        assert.equal(health.status, 200);
        assert.equal(health.headers.get("x-content-type-options"), "nosniff");
        assert.equal(health.headers.get("x-frame-options"), "DENY");
        assert.match(health.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
        assert.equal((await globalThis.fetch(`${fixture.baseUrl}/api/auth/me`)).status, 401);
    } finally { await fixture.server.close(); }
});

test("OAuth configuration failure returns 503 and never falls back to anonymous administration", async () => {
    const fake = createFakeControl();
    const fixture = await createAuthFixture(fake.control, { environment: {}, seedSession: false });
    try {
        assert.equal((await globalThis.fetch(`${fixture.baseUrl}/api/status`)).status, 503);
        assert.equal((await globalThis.fetch(`${fixture.baseUrl}/api/config`)).status, 503);
        assert.equal((await globalThis.fetch(`${fixture.baseUrl}/api/events`)).status, 503);
        const me = await globalThis.fetch(`${fixture.baseUrl}/api/auth/me`);
        assert.equal(me.status, 503);
        const login = await globalThis.fetch(`${fixture.baseUrl}/api/auth/github`);
        assert.equal(login.status, 503);
        assert.equal((await globalThis.fetch(`${fixture.baseUrl}/api/health`)).status, 200);
    } finally { await fixture.server.close(); }
});

test("GitHub OAuth start sets a random short-lived state cookie without requesting scopes", async () => {
    const fake = createFakeControl();
    const fixture = await createAuthFixture(fake.control, { seedSession: false });
    try {
        const { response, location, stateCookie } = await startOAuth(fixture);
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.equal(location.origin, "https://github.com");
        assert.equal(location.pathname, "/login/oauth/authorize");
        assert.equal(location.searchParams.get("client_id"), authEnvironment.GITHUB_OAUTH_CLIENT_ID);
        assert.equal(location.searchParams.get("redirect_uri"), authEnvironment.GITHUB_OAUTH_CALLBACK_URL);
        const state = location.searchParams.get("state")!;
        assert.match(state, /^[A-Za-z0-9_-]{43}$/);
        assert.equal(location.searchParams.has("scope"), false);
        const stateHeader = response.headers.getSetCookie().find((item) => item.startsWith(`${OAUTH_STATE_COOKIE}=`))!;
        assert.match(stateHeader, /HttpOnly/);
        assert.match(stateHeader, /SameSite=Lax/);
        assert.match(stateHeader, /Path=\//);
        assert.match(stateHeader, /Max-Age=600/);
        assert.equal(stateCookie, state);
    } finally { await fixture.server.close(); }
});

test("OAuth callback rejects mismatched, expired, and missing-code states without contacting GitHub", async () => {
    const fake = createFakeControl();
    let now = 100_000;
    let githubRequests = 0;
    const fixture = await createAuthFixture(fake.control, {
        seedSession: false,
        now: () => now,
        fetch: async () => { githubRequests++; return new Response("{}"); },
    });
    try {
        const mismatch = await startOAuth(fixture);
        const mismatched = await callbackRequest(fixture.baseUrl, mismatch.stateCookie, "code=sample&state=not-the-state");
        assert.equal(mismatched.status, 400);
        assert.match(mismatched.headers.getSetCookie().join(";"), /Max-Age=0/);

        const noCode = await startOAuth(fixture);
        const missingCode = await callbackRequest(fixture.baseUrl, noCode.stateCookie, `state=${noCode.location.searchParams.get("state")}`);
        assert.equal(missingCode.status, 400);

        const expired = await startOAuth(fixture);
        now += 10 * 60 * 1000 + 1;
        const expiredResponse = await callbackRequest(fixture.baseUrl, expired.stateCookie,
            `code=sample&state=${expired.location.searchParams.get("state")}`);
        assert.equal(expiredResponse.status, 400);
        assert.equal(githubRequests, 0);
    } finally { await fixture.server.close(); }
});

test("allowlisted GitHub ID creates a durable hash-only Session and exposes no OAuth secret", async () => {
    const fake = createFakeControl();
    const githubCalls: Array<{ url: string; init?: RequestInit }> = [];
    const githubFetch: typeof fetch = async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        githubCalls.push({ url, init });
        if (url === "https://github.com/login/oauth/access_token") {
            const form = new URLSearchParams(init?.body as URLSearchParams);
            assert.equal(form.get("client_secret"), authEnvironment.GITHUB_OAUTH_CLIENT_SECRET);
            assert.equal(form.get("redirect_uri"), authEnvironment.GITHUB_OAUTH_CALLBACK_URL);
            assert.equal(form.has("scope"), false);
            return new Response(JSON.stringify({ access_token: "github-short-lived-token" }), { status: 200 });
        }
        assert.equal(url, "https://api.github.com/user");
        assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer github-short-lived-token");
        assert.match(new Headers(init?.headers).get("Accept") ?? "", /github\+json/);
        assert.equal(new Headers(init?.headers).get("User-Agent"), "TenBot-WebUI");
        return new Response(JSON.stringify({ id: 12345678, login: "test-admin", avatar_url: "https://avatars.githubusercontent.com/u/12345678" }), { status: 200 });
    };
    const fixture = await createAuthFixture(fake.control, { seedSession: false, fetch: githubFetch });
    try {
        const started = await startOAuth(fixture);
        const callback = await callbackRequest(fixture.baseUrl, started.stateCookie,
            `code=temporary-code&state=${started.location.searchParams.get("state")}`);
        assert.equal(callback.status, 302);
        assert.equal(callback.headers.get("location"), "/");
        assert.equal(callback.headers.get("cache-control"), "no-store");
        const cookies = callback.headers.getSetCookie();
        const sessionCookie = cookies.find((item) => item.startsWith(`${WEB_SESSION_COOKIE}=`))!;
        const rawToken = sessionCookie.split(";", 1)[0]!.slice(WEB_SESSION_COOKIE.length + 1);
        assert.match(sessionCookie, /HttpOnly/);
        assert.match(sessionCookie, /SameSite=Lax/);
        assert.match(sessionCookie, /Path=\//);
        assert.match(sessionCookie, /Max-Age=604800/);
        assert.doesNotMatch(sessionCookie, /; Secure/);
        assert.ok(cookies.some((item) => item.startsWith(`${OAUTH_STATE_COOKIE}=`) && /Max-Age=0/.test(item)));
        assert.equal(githubCalls.length, 2);

        const db = new DatabaseSync(join(fixture.directory, "bot.db"));
        try {
            const rows = db.prepare("SELECT token_hash FROM web_sessions").all() as Array<{ token_hash: string }>;
            assert.equal(rows.length, 1);
            assert.equal(rows[0]?.token_hash, createTokenHash(rawToken));
            assert.notEqual(rows[0]?.token_hash, rawToken);
        } finally { db.close(); }
        assert.equal(fixture.repository.find(rawToken, Date.now()), null);

        const me = await globalThis.fetch(`${fixture.baseUrl}/api/auth/me`, { headers: { Cookie: sessionCookie.split(";", 1)[0]! } });
        assert.equal(me.status, 200);
        assert.deepEqual(await me.json(), { authenticated: true, user: { id: "12345678", login: "test-admin", avatarUrl: "https://avatars.githubusercontent.com/u/12345678" } });
        assert.equal(me.headers.get("cache-control"), "no-store");
        const status = await globalThis.fetch(`${fixture.baseUrl}/api/status`, { headers: { Cookie: sessionCookie.split(";", 1)[0]! } });
        assert.equal(status.status, 200);
        const publicConfig = await globalThis.fetch(`${fixture.baseUrl}/api/config`, { headers: { Cookie: sessionCookie.split(";", 1)[0]! } });
        assert.doesNotMatch(await publicConfig.text(), /test-client-secret|github-short-lived-token/);
    } finally { await fixture.server.close(); }
});

test("non-allowlisted GitHub ID receives 403 and cannot create a Session", async () => {
    const fake = createFakeControl();
    const githubFetch: typeof fetch = async (input) => String(input).includes("access_token")
        ? new Response(JSON.stringify({ access_token: "temporary" }), { status: 200 })
        : new Response(JSON.stringify({ id: 87654321, login: "not-admin", avatar_url: null }), { status: 200 });
    const fixture = await createAuthFixture(fake.control, { seedSession: false, fetch: githubFetch });
    try {
        const started = await startOAuth(fixture);
        const denied = await callbackRequest(fixture.baseUrl, started.stateCookie,
            `code=temporary-code&state=${started.location.searchParams.get("state")}`);
        assert.equal(denied.status, 403);
        assert.match(await denied.text(), /numeric user ID/);
        const db = new DatabaseSync(join(fixture.directory, "bot.db"));
        try { assert.equal(db.prepare("SELECT COUNT(*) AS count FROM web_sessions").get()?.count, 0); }
        finally { db.close(); }
    } finally { await fixture.server.close(); }
});

test("sessions reject invalid and expired tokens, delete expiry, and logout immediately revokes the token", async () => {
    const fake = createFakeControl();
    const fixture = await createAuthFixture(fake.control);
    const expiredToken = "expired-session-token";
    const now = Date.now();
    fixture.repository.create(createTokenHash(expiredToken), fixture.user, now - 10_000, now - 1);
    try {
        assert.equal((await globalThis.fetch(`${fixture.baseUrl}/api/status`, { headers: { Cookie: `${WEB_SESSION_COOKIE}=invalid-token` } })).status, 401);
        assert.equal((await globalThis.fetch(`${fixture.baseUrl}/api/status`, { headers: { Cookie: `${WEB_SESSION_COOKIE}=${expiredToken}` } })).status, 401);
        assert.equal(fixture.repository.find(expiredToken, Date.now()), null);

        const logout = await fetch(`${fixture.baseUrl}/api/auth/logout`, { method: "POST" });
        assert.equal(logout.status, 200);
        assert.deepEqual(await logout.json(), { ok: true });
        assert.match(logout.headers.get("set-cookie") ?? "", /Max-Age=0/);
        assert.equal((await globalThis.fetch(`${fixture.baseUrl}/api/status`, {
            headers: { Cookie: `${WEB_SESSION_COOKIE}=${fixture.rawToken}` },
        })).status, 401);
    } finally { await fixture.server.close(); }
});

test("SQLite web sessions survive repository close and reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tenbot-session-restart-"));
    const path = join(directory, "bot.db");
    const token = randomBytes(32).toString("base64url");
    const user = { id: "12345678", login: "durable-admin", avatarUrl: null };
    const now = Date.now();
    try {
        const first = new WebSessionRepository(path);
        first.create(createTokenHash(token), user, now, now + WEB_SESSION_TTL_MS);
        first.close();
        const afterRestart = new WebSessionRepository(path);
        try { assert.deepEqual(afterRestart.find(createTokenHash(token), now), { ...user, createdAt: now, expiresAt: now + WEB_SESSION_TTL_MS }); }
        finally { afterRestart.close(); }
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test("logout without a session remains an idempotent public operation", async () => {
    const fixture = await createAuthFixture(createFakeControl().control, { seedSession: false });
    try {
        const response = await globalThis.fetch(`${fixture.baseUrl}/api/auth/logout`, { method: "POST" });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { ok: true });
        assert.match(response.headers.get("set-cookie") ?? "", /Max-Age=0/);
    } finally { await fixture.server.close(); }
});

test("HTTPS callback config marks OAuth state and session cookies Secure", async () => {
    const fake = createFakeControl();
    const environment = {
        ...authEnvironment,
        GITHUB_OAUTH_CALLBACK_URL: "https://bot.tenqui.ink/api/auth/github/callback",
    };
    const githubFetch: typeof fetch = async (input) => String(input).includes("access_token")
        ? new Response(JSON.stringify({ access_token: "temporary" }), { status: 200 })
        : new Response(JSON.stringify({ id: 12345678, login: "test-admin", avatar_url: null }), { status: 200 });
    const fixture = await createAuthFixture(fake.control, { environment, seedSession: false, fetch: githubFetch });
    try {
        const started = await startOAuth(fixture);
        assert.match(started.response.headers.getSetCookie().join(";"), /; Secure/);
        const callback = await callbackRequest(fixture.baseUrl, started.stateCookie,
            `code=temporary-code&state=${started.location.searchParams.get("state")}`);
        assert.match(callback.headers.getSetCookie().join(";"), /tenbot_session=.*; Secure/);
    } finally { await fixture.server.close(); }
});

test("authenticated mutation requires the exact configured Origin and allows the configured WebUI origin", async () => {
    const fake = createFakeControl();
    const fixture = await startServer(fake.control);
    try {
        const patch = { field: "replyJudge.model", value: "origin-test" };
        const denied = await fetch(`${fixture.baseUrl}/api/config`, {
            method: "PATCH",
            headers: { Origin: "https://attacker.example", "Content-Type": "application/json" },
            body: JSON.stringify(patch),
        });
        assert.equal(denied.status, 403);
        assert.deepEqual(fake.patchCalls, []);

        const noOrigin = await globalThis.fetch(`${fixture.baseUrl}/api/config`, {
            method: "PATCH",
            headers: { Cookie: `${WEB_SESSION_COOKIE}=${fixture.rawToken}`, "Content-Type": "application/json" },
            body: JSON.stringify(patch),
        });
        assert.equal(noOrigin.status, 403);

        const accepted = await fetch(`${fixture.baseUrl}/api/config`, {
            method: "PATCH",
            headers: { Origin: new URL(authEnvironment.GITHUB_OAUTH_CALLBACK_URL).origin, "Content-Type": "application/json" },
            body: JSON.stringify(patch),
        });
        assert.equal(accepted.status, 200);
        assert.deepEqual(fake.patchCalls, [patch]);
    } finally { await fixture.server.close(); }
});
