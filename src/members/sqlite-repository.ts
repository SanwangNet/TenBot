import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
    MEMBER_COLUMNS, UPSERT_MEMBER_SQL, memberValues, rowToMember, type MemberRow,
} from "./sql.js";
import type { KnownMember, MemberRepository } from "./repository.js";

export const DEFAULT_MEMBER_DATABASE_PATH = resolve(process.cwd(), "data", "bot.db");

export class SqliteMemberRepository implements MemberRepository {
    private readonly database: DatabaseSync;

    constructor(path = DEFAULT_MEMBER_DATABASE_PATH) {
        mkdirSync(dirname(path), { recursive: true });
        this.database = new DatabaseSync(path);
        try {
            this.database.exec(readFileSync(resolve(process.cwd(), "migrations", "0001_group_members.sql"), "utf8"));
        } catch (error) {
            this.database.close();
            throw error;
        }
    }

    close(): void {
        this.database.close();
    }

    async upsertMember(member: KnownMember): Promise<void> {
        this.database.prepare(UPSERT_MEMBER_SQL).run(...memberValues(member));
    }

    async findByOpenid(groupOpenid: string, memberOpenid: string): Promise<KnownMember | null> {
        const row = this.database.prepare(
            `SELECT ${MEMBER_COLUMNS} FROM group_members WHERE group_openid = ? AND member_openid = ?`,
        ).get(groupOpenid, memberOpenid) as MemberRow | undefined;
        return row ? rowToMember(row) : null;
    }

    async findByUsername(groupOpenid: string, username: string): Promise<KnownMember[]> {
        const rows = this.database.prepare(
            `SELECT ${MEMBER_COLUMNS} FROM group_members WHERE group_openid = ? AND username = ? ORDER BY last_seen_at DESC, member_openid`,
        ).all(groupOpenid, username) as unknown as MemberRow[];
        return rows.map(rowToMember);
    }

    async listByGroup(groupOpenid: string): Promise<KnownMember[]> {
        const rows = this.database.prepare(
            `SELECT ${MEMBER_COLUMNS} FROM group_members WHERE group_openid = ? ORDER BY last_seen_at DESC, member_openid`,
        ).all(groupOpenid) as unknown as MemberRow[];
        return rows.map(rowToMember);
    }

    async listAll(): Promise<KnownMember[]> {
        const rows = this.database.prepare(
            `SELECT ${MEMBER_COLUMNS} FROM group_members ORDER BY last_seen_at DESC, member_openid, group_openid`,
        ).all() as unknown as MemberRow[];
        return rows.map(rowToMember);
    }
}
