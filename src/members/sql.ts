import type { KnownMember } from "./repository.js";

export const UPSERT_MEMBER_SQL = `
INSERT INTO group_members (
    group_openid, member_openid, username, role,
    first_seen_at, last_seen_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (group_openid, member_openid) DO UPDATE SET
    username = excluded.username,
    role = COALESCE(excluded.role, group_members.role),
    last_seen_at = excluded.last_seen_at,
    updated_at = excluded.updated_at`;

export const MEMBER_COLUMNS =
    "group_openid, member_openid, username, role, first_seen_at, last_seen_at, updated_at";

export interface MemberRow {
    group_openid: string;
    member_openid: string;
    username: string;
    role: string | null;
    first_seen_at: number;
    last_seen_at: number;
    updated_at: number;
}

export function rowToMember(row: MemberRow): KnownMember {
    return {
        groupOpenid: row.group_openid,
        memberOpenid: row.member_openid,
        username: row.username,
        ...(row.role === null ? {} : { role: row.role }),
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
        updatedAt: row.updated_at,
    };
}

export function memberValues(member: KnownMember): [string, string, string, string | null, number, number, number] {
    return [
        member.groupOpenid, member.memberOpenid, member.username, member.role ?? null,
        member.firstSeenAt, member.lastSeenAt, member.updatedAt,
    ];
}
