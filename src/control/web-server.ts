import { createServer, type Server, type ServerResponse } from "node:http";
import type { TenBotControl } from "./tenbot-control.js";
import { logger } from "../shared/logger.js";

const SSE_HEARTBEAT_MS = 25_000;

interface WebServerOptions {
    host: string;
    port: number;
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

/** HTTP transport for the shared Runtime Control Plane. */
export function createTenBotWebServer(control: TenBotControl, options: WebServerOptions) {
    if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) {
        throw new Error("Web server port must be an integer between 0 and 65535");
    }

    const clients = new Set<SseClient>();
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

        if (request.method !== "GET") {
            response.setHeader("Allow", "GET");
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

        error(response, 404, "Not found");
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
