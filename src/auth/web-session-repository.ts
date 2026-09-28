import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface WebSessionUser {
    id: string;
    login: string;
    avatarUrl: string | null;
}

export interface WebSession extends WebSessionUser {
    createdAt: number;
    expiresAt: number;
}

interface SessionRow {
    github_user_id: string;
    github_login: string;
    github_avatar_url: string | null;
    created_at: number;
    expires_at: number;
}

export const DEFAULT_WEB_SESSION_DATABASE_PATH = resolve(process.cwd(), "data", "bot.db");

export class WebSessionRepository {
    private readonly database: DatabaseSync;

    constructor(path = DEFAULT_WEB_SESSION_DATABASE_PATH) {
        mkdirSync(dirname(path), { recursive: true });
        this.database = new DatabaseSync(path);
        try {
            this.database.exec(readFileSync(resolve(process.cwd(), "migrations", "0003_web_auth.sql"), "utf8"));
        } catch (cause) {
            this.database.close();
            throw cause;
        }
    }

    create(tokenHash: string, user: WebSessionUser, createdAt: number, expiresAt: number): void {
        this.database.prepare(`
            INSERT INTO web_sessions (token_hash, github_user_id, github_login, github_avatar_url, created_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(tokenHash, user.id, user.login, user.avatarUrl, createdAt, expiresAt);
    }

    find(tokenHash: string, now: number): WebSession | null {
        const row = this.database.prepare(`
            SELECT github_user_id, github_login, github_avatar_url, created_at, expires_at
            FROM web_sessions WHERE token_hash = ?
        `).get(tokenHash) as SessionRow | undefined;
        if (!row) return null;
        if (row.expires_at <= now) {
            this.delete(tokenHash);
            return null;
        }
        return {
            id: row.github_user_id,
            login: row.github_login,
            avatarUrl: row.github_avatar_url,
            createdAt: row.created_at,
            expiresAt: row.expires_at,
        };
    }

    delete(tokenHash: string): void {
        this.database.prepare("DELETE FROM web_sessions WHERE token_hash = ?").run(tokenHash);
    }

    close(): void {
        this.database.close();
    }
}
