import {
    MEMBER_COLUMNS, UPSERT_MEMBER_SQL, memberValues, rowToMember, type MemberRow,
} from "./sql.js";
import type { KnownMember, MemberRepository } from "./repository.js";

// Only the D1 operations used here are required; the service imports no Worker types.
export interface D1MemberDatabase {
    prepare(query: string): {
        bind(...values: Array<string | number | null>): {
            run(): Promise<unknown>;
            first<T>(): Promise<T | null>;
            all<T>(): Promise<{ results: T[] }>;
        };
    };
}

export class D1MemberRepository implements MemberRepository {
    constructor(private readonly database: D1MemberDatabase) {}

    async upsertMember(member: KnownMember): Promise<void> {
        await this.database.prepare(UPSERT_MEMBER_SQL).bind(...memberValues(member)).run();
    }

    async findByOpenid(groupOpenid: string, memberOpenid: string): Promise<KnownMember | null> {
        const row = await this.database.prepare(
            `SELECT ${MEMBER_COLUMNS} FROM group_members WHERE group_openid = ? AND member_openid = ?`,
        ).bind(groupOpenid, memberOpenid).first<MemberRow>();
        return row ? rowToMember(row) : null;
    }

    async findByUsername(groupOpenid: string, username: string): Promise<KnownMember[]> {
        const result = await this.database.prepare(
            `SELECT ${MEMBER_COLUMNS} FROM group_members WHERE group_openid = ? AND username = ? ORDER BY last_seen_at DESC, member_openid`,
        ).bind(groupOpenid, username).all<MemberRow>();
        return result.results.map(rowToMember);
    }

    async listByGroup(groupOpenid: string): Promise<KnownMember[]> {
        const result = await this.database.prepare(
            `SELECT ${MEMBER_COLUMNS} FROM group_members WHERE group_openid = ? ORDER BY last_seen_at DESC, member_openid`,
        ).bind(groupOpenid).all<MemberRow>();
        return result.results.map(rowToMember);
    }
}
