import { createServer, type Server, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { TenBotControl } from "./tenbot-control.js";
import { logger } from "../shared/logger.js";
import { parsePublicConfigPatch, validatePublicConfigPatch } from "../config/config-validation.js";

const SSE_HEARTBEAT_MS = 25_000;
const MAX_CONFIG_PATCH_BODY_BYTES = 16 * 1024;

class HttpInputError extends Error {
    constructor(readonly statusCode: number, message: string) { super(message); }
}

interface WebServerOptions {
    host: string;
    port: number;
    /** Optional static root for tests and packaged deployments. Defaults to web/dist. */
    staticDirectory?: string;
}

interface WebServerAddress {
    host: string;
    port: number;
}

interface SseClient {
    response: ServerResponse;
    heartbeat: NodeJS.Timeout;
    unsubscribe: Array<() => void>;
    closed: boolean;
    close(): void;
}

function json(response: ServerResponse, statusCode: number, body: unknown): void {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(body));
}

function error(response: ServerResponse, statusCode: number, message: string): void {
    json(response, statusCode, { error: { message } });
}

function urlHost(host: string): string {
    return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function errorText(value: unknown): string {
    return value instanceof Error ? value.message : "Unknown server error";
}

const CONTENT_TYPES: Record<string, string> = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".txt": "text/plain; charset=utf-8",
    ".webp": "image/webp",
    ".woff2": "font/woff2",
};

/** HTTP transport for the shared Runtime Control Plane. */
export function createTenBotWebServer(control: TenBotControl, options: WebServerOptions) {
    if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) {
        throw new Error("Web server port must be an integer between 0 and 65535");
    }

    const clients = new Set<SseClient>();
    const staticDirectory = resolve(options.staticDirectory ?? resolve(process.cwd(), "web", "dist"));
    let startPromise: Promise<WebServerAddress> | undefined;
    let closePromise: Promise<void> | undefined;
    let closing = false;
    let started = false;

    const server: Server = createServer((request, response) => {
        void handleRequest(request, response).catch(() => {
            if (!response.headersSent) error(response, 500, "Internal server error");
            else if (!response.writableEnded) response.end();
        });
    });

    server.on("error", (cause) => {
        if (started && !closing) logger.error(`[Web] server error: ${errorText(cause)}`);
    });

    function sendEvent(client: SseClient, event: string, payload: unknown): void {
        if (client.closed || client.response.destroyed || client.response.writableEnded) {
            client.close();
            return;
        }
        try {
            client.response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
        } catch {
            client.close();
        }
    }

    function openEvents(response: ServerResponse): void {
        response.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
        });
        response.flushHeaders();

        const client: SseClient = {
            response,
            heartbeat: undefined as unknown as NodeJS.Timeout,
            unsubscribe: [] as Array<() => void>,
            closed: false,
            close() {
                if (client.closed) return;
                client.closed = true;
                clearInterval(client.heartbeat);
                clients.delete(client);
                response.off("close", client.close);
                response.off("finish", client.close);
                for (const unsubscribe of client.unsubscribe.splice(0)) {
                    try { unsubscribe(); } catch { /* A closed stream must not retain other listeners. */ }
                }
            },
        };

        clients.add(client);
        response.once("close", client.close);
        response.once("finish", client.close);
        client.heartbeat = setInterval(() => {
            if (client.closed || response.destroyed || response.writableEnded) {
                client.close();
                return;
            }
            try { response.write(": heartbeat\n\n"); }
            catch { client.close(); }
        }, SSE_HEARTBEAT_MS);
        client.heartbeat.unref();

        client.unsubscribe.push(control.subscribeStatus((status) => sendEvent(client, "status", status)));
        client.unsubscribe.push(control.subscribeLogs((entry) => sendEvent(client, "log", entry)));
        client.unsubscribe.push(control.subscribeEvents((event) => sendEvent(client, "runtime-event", event)));
    }

    async function handleRequest(request: import("node:http").IncomingMessage, response: ServerResponse): Promise<void> {
        if (closing) {
            error(response, 503, "Service unavailable");
            return;
        }

        let pathname: string;
        try { pathname = new URL(request.url ?? "/", "http://localhost").pathname; }
        catch {
            error(response, 400, "Bad request");
            return;
        }

        if (pathname === "/api/config" && request.method === "PATCH") {
            await updateConfig(request, response);
            return;
        }

        if (request.method !== "GET") {
            response.setHeader("Allow", pathname === "/api/config" ? "GET, PATCH" : "GET");
            error(response, 405, "Method not allowed");
            return;
        }

        if (pathname === "/api/health") {
            const status = control.getStatus();
            json(response, 200, { ok: true, qq: status.qq, shuttingDown: status.shuttingDown });
            return;
        }
        if (pathname === "/api/status") {
            json(response, 200, control.getStatus());
            return;
        }
        if (pathname === "/api/config") {
            json(response, 200, control.getConfig());
            return;
        }
        if (pathname === "/api/conversations") {
            json(response, 200, control.getConversations());
            return;
        }
        const conversationPrefix = "/api/conversations/";
        if (pathname.startsWith(conversationPrefix)) {
            const encodedId = pathname.slice(conversationPrefix.length);
            if (!encodedId || encodedId.includes("/")) {
                error(response, 404, "Not found");
                return;
            }
            let id: string;
            try { id = decodeURIComponent(encodedId); }
            catch {
                error(response, 400, "Bad request");
                return;
            }
            if (!control.getConversations().some((conversation) => conversation.conversationId === id)) {
                error(response, 404, "Not found");
                return;
            }
            json(response, 200, control.getConversationTimeline(id));
            return;
        }
        if (pathname === "/api/automated-peers") {
            json(response, 200, { registered: control.getAutomatedPeers(), recent: control.getRecentPeers() });
            return;
        }
        if (pathname === "/api/known-members") {
            json(response, 200, await control.getKnownMembers());
            return;
        }
        if (pathname === "/api/events") {
            openEvents(response);
            return;
        }

        if (pathname === "/api" || pathname.startsWith("/api/")) {
            error(response, 404, "Not found");
            return;
        }

        await serveStatic(pathname, response);
    }

    async function updateConfig(request: import("node:http").IncomingMessage, response: ServerResponse): Promise<void> {
        let rawPatch: unknown;
        try { rawPatch = await readJsonBody(request); }
        catch (cause) {
            if (cause instanceof HttpInputError) error(response, cause.statusCode, cause.message);
            else error(response, 400, "Invalid request body");
            return;
        }

        const patch = parsePublicConfigPatch(rawPatch);
        if (!patch) {
            error(response, 400, "Unsupported configuration patch");
            return;
        }
        try { validatePublicConfigPatch(patch); }
        catch (cause) {
            error(response, 400, cause instanceof Error ? cause.message : "Invalid configuration value");
            return;
        }

        try {
            const result = await control.updateConfig(patch);
            if (!result.ok) {
                error(response, 500, "Unable to save configuration");
                return;
            }
            json(response, 200, { result, config: control.getConfig() });
        } catch {
            error(response, 500, "Unable to save configuration");
        }
    }

    async function readJsonBody(request: import("node:http").IncomingMessage): Promise<unknown> {
        const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
        if (contentType !== "application/json") throw new HttpInputError(415, "Content-Type must be application/json");
        const chunks: Buffer[] = [];
        let size = 0;
        let tooLarge = false;
        for await (const chunk of request) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += buffer.length;
            if (size <= MAX_CONFIG_PATCH_BODY_BYTES) chunks.push(buffer);
            else tooLarge = true;
        }
        if (tooLarge) throw new HttpInputError(413, "Request body is too large");
        try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
        catch { throw new HttpInputError(400, "Invalid JSON body"); }
    }

    async function serveStatic(pathname: string, response: ServerResponse): Promise<void> {
        let decodedPath: string;
        try { decodedPath = decodeURIComponent(pathname); }
        catch {
            error(response, 400, "Bad request");
            return;
        }

        const requestedPath = resolve(staticDirectory, `.${decodedPath}`);
        const pathFromRoot = relative(staticDirectory, requestedPath);
        if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
            error(response, 404, "Not found");
            return;
        }

        let filePath = requestedPath;
        let fileInfo;
        try {
            fileInfo = await stat(filePath);
            if (fileInfo.isDirectory()) {
                filePath = resolve(filePath, "index.html");
                fileInfo = await stat(filePath);
            }
        } catch {
            if (extname(decodedPath)) {
                error(response, 404, "Not found");
                return;
            }
            filePath = resolve(staticDirectory, "index.html");
            try { fileInfo = await stat(filePath); }
            catch {
                error(response, 404, "Not found");
                return;
            }
        }

        if (!fileInfo.isFile()) {
            error(response, 404, "Not found");
            return;
        }

        const contentType = CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
        const headers: Record<string, string | number> = { "Content-Type": contentType, "Content-Length": fileInfo.size };
        if (extname(filePath).toLowerCase() === ".html") headers["Cache-Control"] = "no-cache";
        response.writeHead(200, headers);
        response.end(await readFile(filePath));
    }

    return {
        start(): Promise<WebServerAddress> {
            if (closing) return Promise.reject(new Error("Web server is closing"));
            if (startPromise) return startPromise;
            startPromise = new Promise<WebServerAddress>((resolve, reject) => {
                const onError = (cause: Error) => {
                    server.off("listening", onListening);
                    logger.error(`[Web] listen failed host=${options.host} port=${options.port}: ${errorText(cause)}`);
                    reject(cause);
                };
                const onListening = () => {
                    server.off("error", onError);
                    started = true;
                    const address = server.address();
                    const port = address && typeof address === "object" ? address.port : options.port;
                    logger.info(`[Web] listening on http://${urlHost(options.host)}:${port}`);
                    resolve({ host: options.host, port });
                };
                server.once("error", onError);
                server.once("listening", onListening);
                server.listen(options.port, options.host);
            });
            return startPromise;
        },
        close(): Promise<void> {
            if (closePromise) return closePromise;
            closing = true;
            closePromise = (async () => {
                await startPromise?.catch(() => undefined);
                const wasListening = server.listening;
                const stopped = wasListening
                    ? new Promise<void>((resolve, reject) => {
                        server.close((cause) => cause ? reject(cause) : resolve());
                    })
                    : Promise.resolve();
                for (const client of [...clients]) {
                    client.close();
                    if (!client.response.destroyed && !client.response.writableEnded) client.response.end();
                }
                await stopped;
                if (wasListening) {
                    started = false;
                    logger.info("[Web] stopped");
                }
            })();
            return closePromise;
        },
    };
}
