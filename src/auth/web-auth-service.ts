import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { logger } from "../shared/logger.js";
import type { WebSessionRepository, WebSessionUser } from "./web-session-repository.js";

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_OAUTH_STATES = 1_000;
export const WEB_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const WEB_SESSION_COOKIE = "tenbot_session";
export const OAUTH_STATE_COOKIE = "tenbot_oauth_state";

export interface GitHubOAuthConfig {
    clientId: string;
    clientSecret: string;
    callbackUrl: URL;
    allowedUserIds: ReadonlySet<string>;
}

export interface OAuthConfigResult {
    config?: GitHubOAuthConfig;
    error?: string;
}

function parseAllowedUserIds(value: string): Set<string> {
    const ids = value.split(",").map((item) => item.trim()).filter(Boolean);
    const normalized = new Set<string>();
    for (const id of ids) {
        if (!/^\d+$/.test(id) || BigInt(id) <= 0n) throw new Error("Invalid GitHub numeric user ID allowlist");
        normalized.add(BigInt(id).toString());
    }
    if (!normalized.size) throw new Error("GitHub numeric user ID allowlist is empty");
    return normalized;
}

export function loadGitHubOAuthConfig(environment: NodeJS.ProcessEnv): OAuthConfigResult {
    const clientId = environment.GITHUB_OAUTH_CLIENT_ID?.trim();
    const clientSecret = environment.GITHUB_OAUTH_CLIENT_SECRET?.trim();
    const callbackValue = environment.GITHUB_OAUTH_CALLBACK_URL?.trim();
    const allowedValue = environment.GITHUB_OAUTH_ALLOWED_USER_IDS?.trim();
    if (!clientId || !clientSecret || !callbackValue || !allowedValue) {
        return { error: "GitHub OAuth is not configured" };
    }
    try {
        const callbackUrl = new URL(callbackValue);
        const isLoopbackHttp = callbackUrl.protocol === "http:" &&
            ["localhost", "127.0.0.1", "[::1]"].includes(callbackUrl.hostname);
        if ((callbackUrl.protocol !== "https:" && !isLoopbackHttp) || callbackUrl.username || callbackUrl.password || callbackUrl.search || callbackUrl.hash) {
            throw new Error("Invalid GitHub OAuth callback URL");
        }
        if (/[\r\n]/.test(clientId) || /[\r\n]/.test(clientSecret)) throw new Error("Invalid GitHub OAuth credentials");
        return { config: { clientId, clientSecret, callbackUrl, allowedUserIds: parseAllowedUserIds(allowedValue) } };
    } catch {
        return { error: "GitHub OAuth configuration is invalid" };
    }
}

export type OAuthCompletion =
    | { kind: "success"; token: string; user: WebSessionUser }
    | { kind: "denied"; id: string }
    | { kind: "invalid" }
    | { kind: "unavailable" };

interface OAuthState {
    expiresAt: number;
}

interface GitHubTokenResponse {
    access_token?: unknown;
}

interface GitHubUserResponse {
    id?: unknown;
    login?: unknown;
    avatar_url?: unknown;
}

export class WebAuthService {
    private readonly states = new Map<string, OAuthState>();
    private readonly configResult: OAuthConfigResult;
    private readonly fetcher: typeof fetch;
    private readonly now: () => number;

    constructor(
        environment: NodeJS.ProcessEnv,
        private readonly sessions: WebSessionRepository | undefined,
        options: { fetch?: typeof fetch; now?: () => number } = {},
    ) {
        this.configResult = loadGitHubOAuthConfig(environment);
        this.fetcher = options.fetch ?? fetch;
        this.now = options.now ?? Date.now;
    }

    get configured(): boolean {
        return Boolean(this.configResult.config && this.sessions);
    }

    get secureCookies(): boolean {
        return this.configResult.config?.callbackUrl.protocol === "https:";
    }

    get allowedOrigin(): string | undefined {
        return this.configResult.config?.callbackUrl.origin;
    }

    startOAuth(): { location: string; state: string } | null {
        const config = this.configResult.config;
        if (!config || !this.sessions) return null;
        const now = this.now();
        for (const [state, item] of this.states) if (item.expiresAt <= now) this.states.delete(state);
        while (this.states.size >= MAX_PENDING_OAUTH_STATES) {
            const oldest = this.states.keys().next().value as string | undefined;
            if (!oldest) break;
            this.states.delete(oldest);
        }
        const state = randomBytes(32).toString("base64url");
        this.states.set(state, { expiresAt: now + OAUTH_STATE_TTL_MS });
        const authorize = new URL("https://github.com/login/oauth/authorize");
        authorize.searchParams.set("client_id", config.clientId);
        authorize.searchParams.set("redirect_uri", config.callbackUrl.toString());
        authorize.searchParams.set("state", state);
        logger.info("[Auth] GitHub login started");
        return { location: authorize.toString(), state };
    }

    async completeOAuth(code: string | undefined, state: string | undefined, cookieState: string | undefined): Promise<OAuthCompletion> {
        const config = this.configResult.config;
        const sessions = this.sessions;
        if (!config || !sessions) return { kind: "unavailable" };

        const candidate = cookieState;
        const stored = candidate ? this.states.get(candidate) : undefined;
        if (candidate) this.states.delete(candidate);
        if (state) this.states.delete(state);
        const stateMatches = Boolean(safeStateEquals(state, candidate) && stored && stored.expiresAt > this.now());
        if (!stateMatches || !code) return { kind: "invalid" };

        try {
            const tokenResponse = await this.fetcher("https://github.com/login/oauth/access_token", {
                method: "POST",
                headers: {
                    Accept: "application/json",
                    "Content-Type": "application/x-www-form-urlencoded",
                    "User-Agent": "TenBot-WebUI",
                },
                body: new URLSearchParams({
                    client_id: config.clientId,
                    client_secret: config.clientSecret,
                    code,
                    redirect_uri: config.callbackUrl.toString(),
                }),
                signal: AbortSignal.timeout(10_000),
            });
            if (!tokenResponse.ok) return { kind: "unavailable" };
            const tokenBody = await tokenResponse.json() as GitHubTokenResponse;
            if (typeof tokenBody.access_token !== "string" || !tokenBody.access_token) return { kind: "unavailable" };

            const userResponse = await this.fetcher("https://api.github.com/user", {
                headers: {
                    Accept: "application/vnd.github+json",
                    Authorization: `Bearer ${tokenBody.access_token}`,
                    "User-Agent": "TenBot-WebUI",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
                signal: AbortSignal.timeout(10_000),
            });
            if (!userResponse.ok) return { kind: "unavailable" };
            const userBody = await userResponse.json() as GitHubUserResponse;
            if (typeof userBody.id !== "number" || !Number.isSafeInteger(userBody.id) || userBody.id <= 0 ||
                typeof userBody.login !== "string" || !userBody.login ||
                (userBody.avatar_url !== undefined && userBody.avatar_url !== null && typeof userBody.avatar_url !== "string")) {
                return { kind: "unavailable" };
            }
            const id = String(userBody.id);
            if (!config.allowedUserIds.has(id)) {
                logger.info(`[Auth] login denied id=${id}`);
                return { kind: "denied", id };
            }

            const user = { id, login: userBody.login, avatarUrl: typeof userBody.avatar_url === "string" ? userBody.avatar_url : null };
            const token = randomBytes(32).toString("base64url");
            const createdAt = this.now();
            sessions.create(createTokenHash(token), user, createdAt, createdAt + WEB_SESSION_TTL_MS);
            logger.info(`[Auth] login success user=${user.login} id=${id}`);
            return { kind: "success", token, user };
        } catch {
            return { kind: "unavailable" };
        }
    }

    getSession(rawToken: string | undefined) {
        if (!rawToken || !this.sessions || !this.configResult.config) return null;
        return this.sessions.find(createTokenHash(rawToken), this.now());
    }

    logout(rawToken: string | undefined): void {
        if (!rawToken || !this.sessions) return;
        const session = this.sessions.find(createTokenHash(rawToken), this.now());
        this.sessions.delete(createTokenHash(rawToken));
        if (session) logger.info(`[Auth] logout user=${session.id}`);
    }
}

export function createTokenHash(token: string): string {
    return createHash("sha256").update(token).digest("hex");
}

export function safeStateEquals(first: string | undefined, second: string | undefined): boolean {
    if (!first || !second) return false;
    const firstBytes = Buffer.from(first);
    const secondBytes = Buffer.from(second);
    return firstBytes.length === secondBytes.length && timingSafeEqual(firstBytes, secondBytes);
}
