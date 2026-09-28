import {
    MEMBER_COLUMNS, UPSERT_MEMBER_SQL, memberValues, rowToMember, type MemberRow,
} from "./sql.js";
import type { GroupMember, GroupSettings, KnownMember, MemberBotState, MemberRepository } from "./repository.js";

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

    async listAll(): Promise<KnownMember[]> {
        const result = await this.database.prepare(
            `SELECT ${MEMBER_COLUMNS} FROM group_members ORDER BY last_seen_at DESC, member_openid, group_openid`,
        ).bind().all<MemberRow>();
        return result.results.map(rowToMember);
    }

    async getMemberBotState(groupOpenid: string, memberOpenid: string): Promise<MemberBotState> {
        const row = await this.database.prepare(`
            SELECT group_openid, member_openid, platform_bot, manual_bot, auto_bot, detection_marks,
                last_detection_at, created_at, updated_at FROM member_bot_state
            WHERE group_openid = ? AND member_openid = ?
        `).bind(groupOpenid, memberOpenid).first<MemberBotStateRow>();
        return row ? rowToBotState(row) : defaultBotState(groupOpenid, memberOpenid);
    }

    async setPlatformBot(groupOpenid: string, memberOpenid: string, enabled: boolean, at: number): Promise<MemberBotState> {
        await this.database.prepare(`
            INSERT INTO member_bot_state (group_openid, member_openid, platform_bot, manual_bot, auto_bot,
                detection_marks, last_detection_at, created_at, updated_at)
            VALUES (?, ?, ?, 0, 0, 0, NULL, ?, ?)
            ON CONFLICT (group_openid, member_openid) DO UPDATE SET platform_bot = excluded.platform_bot,
                updated_at = excluded.updated_at
        `).bind(groupOpenid, memberOpenid, enabled ? 1 : 0, at, at).run();
        return this.getMemberBotState(groupOpenid, memberOpenid);
    }

    async setManualBot(groupOpenid: string, memberOpenid: string, enabled: boolean, at: number): Promise<MemberBotState> {
        await this.database.prepare(`
            INSERT INTO member_bot_state (group_openid, member_openid, platform_bot, manual_bot, auto_bot,
                detection_marks, last_detection_at, created_at, updated_at)
            VALUES (?, ?, 0, ?, 0, 0, NULL, ?, ?)
            ON CONFLICT (group_openid, member_openid) DO UPDATE SET manual_bot = excluded.manual_bot,
                updated_at = excluded.updated_at
        `).bind(groupOpenid, memberOpenid, enabled ? 1 : 0, at, at).run();
        return this.getMemberBotState(groupOpenid, memberOpenid);
    }

    async incrementDetectionMark(groupOpenid: string, memberOpenid: string, at: number, threshold: number): Promise<MemberBotState> {
        const row = await this.database.prepare(`
            INSERT INTO member_bot_state (group_openid, member_openid, platform_bot, manual_bot, auto_bot,
                detection_marks, last_detection_at, created_at, updated_at)
            VALUES (?, ?, 0, 0, CASE WHEN 1 >= ? THEN 1 ELSE 0 END, 1, ?, ?, ?)
            ON CONFLICT (group_openid, member_openid) DO UPDATE SET
                detection_marks = member_bot_state.detection_marks + 1,
                auto_bot = CASE WHEN member_bot_state.detection_marks + 1 >= ? THEN 1 ELSE member_bot_state.auto_bot END,
                last_detection_at = excluded.last_detection_at, updated_at = excluded.updated_at
            RETURNING group_openid, member_openid, platform_bot, manual_bot, auto_bot, detection_marks,
                last_detection_at, created_at, updated_at
        `).bind(groupOpenid, memberOpenid, threshold, at, at, at, threshold).first<MemberBotStateRow>();
        if (!row) throw new Error("Unable to update member bot detection state");
        return rowToBotState(row);
    }

    async resetDetectionMarks(groupOpenid: string, memberOpenid: string, at: number): Promise<MemberBotState> {
        await this.database.prepare(`
            INSERT INTO member_bot_state (group_openid, member_openid, platform_bot, manual_bot, auto_bot,
                detection_marks, last_detection_at, created_at, updated_at)
            VALUES (?, ?, 0, 0, 0, 0, NULL, ?, ?)
            ON CONFLICT (group_openid, member_openid) DO UPDATE SET auto_bot = 0, detection_marks = 0,
                last_detection_at = NULL, updated_at = excluded.updated_at
        `).bind(groupOpenid, memberOpenid, at, at).run();
        return this.getMemberBotState(groupOpenid, memberOpenid);
    }

    async listMarkedBots(): Promise<GroupMember[]> {
        const rows = await this.database.prepare(`${groupMemberSelect}
            WHERE s.platform_bot = 1 OR s.manual_bot = 1 OR s.auto_bot = 1
            ORDER BY m.last_seen_at DESC, m.group_openid, m.member_openid
        `).bind().all<GroupMemberRow>();
        return rows.results.map(rowToGroupMember);
    }

    async listGroupMembers(groupOpenid: string): Promise<GroupMember[]> {
        const rows = await this.database.prepare(`${groupMemberSelect}
            WHERE m.group_openid = ? ORDER BY m.last_seen_at DESC, m.member_openid
        `).bind(groupOpenid).all<GroupMemberRow>();
        return rows.results.map(rowToGroupMember);
    }

    async findGroupMember(groupOpenid: string, memberOpenid: string): Promise<GroupMember | null> {
        const row = await this.database.prepare(`${groupMemberSelect}
            WHERE m.group_openid = ? AND m.member_openid = ?
        `).bind(groupOpenid, memberOpenid).first<GroupMemberRow>();
        return row ? rowToGroupMember(row) : null;
    }

    async wasLegacyAutomatedPeerImportCompleted(): Promise<boolean> {
        const row = await this.database.prepare("SELECT value FROM runtime_state WHERE key = ?")
            .bind("legacy_automated_peer_ids_imported").first<{ value: string }>();
        return row?.value === "1";
    }

    async markLegacyAutomatedPeerImportCompleted(at: number): Promise<void> {
        await this.database.prepare(`
            INSERT INTO runtime_state (key, value, updated_at) VALUES (?, '1', ?)
            ON CONFLICT (key) DO UPDATE SET value = '1', updated_at = excluded.updated_at
        `).bind("legacy_automated_peer_ids_imported", at).run();
    }

    async ensureGroup(groupOpenid: string, at: number, displayName?: string): Promise<GroupSettings> {
        await this.database.prepare(`
            INSERT INTO group_settings (group_openid, replies_enabled, first_seen_at, last_seen_at, display_name, updated_at)
            VALUES (?, 1, ?, ?, ?, ?)
            ON CONFLICT (group_openid) DO UPDATE SET
                last_seen_at = MAX(group_settings.last_seen_at, excluded.last_seen_at),
                display_name = COALESCE(excluded.display_name, group_settings.display_name),
                updated_at = excluded.updated_at
        `).bind(groupOpenid, at, at, cleanGroupName(displayName), at).run();
        const group = await this.getGroupSettings(groupOpenid);
        if (!group) throw new Error("Unable to read ensured group settings");
        return group;
    }

    async getGroupSettings(groupOpenid: string): Promise<GroupSettings | null> {
        const row = await this.database.prepare(`
            SELECT s.group_openid, s.replies_enabled, s.first_seen_at, s.last_seen_at, s.display_name, s.updated_at,
                (SELECT COUNT(*) FROM group_members m WHERE m.group_openid = s.group_openid) AS member_count
            FROM group_settings s WHERE s.group_openid = ?
        `).bind(groupOpenid).first<GroupSettingsRow>();
        return row ? rowToGroupSettings(row) : null;
    }

    async setGroupRepliesEnabledForGroup(groupOpenid: string, enabled: boolean, at: number): Promise<GroupSettings | null> {
        await this.database.prepare("UPDATE group_settings SET replies_enabled = ?, updated_at = ? WHERE group_openid = ?")
            .bind(enabled ? 1 : 0, at, groupOpenid).run();
        return this.getGroupSettings(groupOpenid);
    }

    async listGroups(): Promise<GroupSettings[]> {
        const result = await this.database.prepare(`
            SELECT s.group_openid, s.replies_enabled, s.first_seen_at, s.last_seen_at, s.display_name, s.updated_at,
                (SELECT COUNT(*) FROM group_members m WHERE m.group_openid = s.group_openid) AS member_count
            FROM group_settings s ORDER BY s.last_seen_at DESC, s.group_openid
        `).bind().all<GroupSettingsRow>();
        return result.results.map(rowToGroupSettings);
    }
}

interface GroupSettingsRow {
    group_openid: string;
    replies_enabled: number;
    first_seen_at: number;
    last_seen_at: number;
    display_name: string | null;
    updated_at: number;
    member_count: number;
}

interface MemberBotStateRow {
    group_openid: string;
    member_openid: string;
    platform_bot: number;
    manual_bot: number;
    auto_bot: number;
    detection_marks: number;
    last_detection_at: number | null;
    created_at: number;
    updated_at: number;
}

interface GroupMemberRow extends MemberRow, MemberBotStateRow {}

const groupMemberSelect = `
    SELECT m.group_openid, m.member_openid, m.username, m.role, m.first_seen_at, m.last_seen_at, m.updated_at,
        COALESCE(s.platform_bot, 0) AS platform_bot, COALESCE(s.manual_bot, 0) AS manual_bot,
        COALESCE(s.auto_bot, 0) AS auto_bot, COALESCE(s.detection_marks, 0) AS detection_marks,
        s.last_detection_at, COALESCE(s.created_at, m.first_seen_at) AS created_at,
        COALESCE(s.updated_at, m.updated_at) AS bot_updated_at
    FROM group_members m LEFT JOIN member_bot_state s
        ON s.group_openid = m.group_openid AND s.member_openid = m.member_openid`;

function defaultBotState(groupOpenid: string, memberOpenid: string): MemberBotState {
    return { groupOpenid, memberOpenid, platformBot: false, manualBot: false, autoBot: false,
        detectionMarks: 0, lastDetectionAt: null, createdAt: 0, updatedAt: 0 };
}

function rowToBotState(row: MemberBotStateRow): MemberBotState {
    return { groupOpenid: row.group_openid, memberOpenid: row.member_openid, platformBot: row.platform_bot === 1,
        manualBot: row.manual_bot === 1, autoBot: row.auto_bot === 1, detectionMarks: row.detection_marks,
        lastDetectionAt: row.last_detection_at, createdAt: row.created_at, updatedAt: row.updated_at };
}

function rowToGroupMember(row: GroupMemberRow): GroupMember {
    return { ...rowToMember(row), platformBot: row.platform_bot === 1, manualBot: row.manual_bot === 1,
        autoBot: row.auto_bot === 1, detectionMarks: row.detection_marks, lastDetectionAt: row.last_detection_at };
}

function cleanGroupName(value: string | undefined): string | null {
    const name = value?.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
    return name || null;
}

function rowToGroupSettings(row: GroupSettingsRow): GroupSettings {
    return {
        groupOpenid: row.group_openid,
        repliesEnabled: row.replies_enabled === 1,
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
        updatedAt: row.updated_at,
        ...(row.display_name ? { displayName: row.display_name } : {}),
        memberCount: row.member_count,
    };
}
