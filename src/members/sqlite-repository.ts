import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
    MEMBER_COLUMNS, UPSERT_MEMBER_SQL, memberValues, rowToMember, type MemberRow,
} from "./sql.js";
import {
    MEMBER_BOT_DETECTION_EVIDENCE_TTL_MS,
    type AddMemberBotDetectionEvidence,
    type MemberBotDetectionEvidence,
    type MemberBotDetectionObservation,
} from "./detection-evidence.js";
import type { GroupMember, GroupSettings, KnownMember, MemberBotState, MemberRepository } from "./repository.js";
import type { GroupReplyStateRepository } from "../runtime/group-reply-control.js";

export const DEFAULT_MEMBER_DATABASE_PATH = resolve(process.cwd(), "data", "bot.db");
export const LEGACY_BOT_DETECTION_RESET_MIGRATION_VERSION = 7;

export class SqliteMemberRepository implements MemberRepository, GroupReplyStateRepository {
    private readonly database: DatabaseSync;

    constructor(path = DEFAULT_MEMBER_DATABASE_PATH, private readonly now: () => number = Date.now) {
        mkdirSync(dirname(path), { recursive: true });
        this.database = new DatabaseSync(path);
        try {
            this.database.exec(readFileSync(resolve(process.cwd(), "migrations", "0001_group_members.sql"), "utf8"));
            this.database.exec(readFileSync(resolve(process.cwd(), "migrations", "0002_runtime_state.sql"), "utf8"));
            this.database.exec(readFileSync(resolve(process.cwd(), "migrations", "0004_group_settings.sql"), "utf8"));
            this.database.exec(readFileSync(resolve(process.cwd(), "migrations", "0005_member_bot_state.sql"), "utf8"));
            this.database.exec(readFileSync(resolve(process.cwd(), "migrations", "0006_member_bot_detection_events.sql"), "utf8"));
            this.database.exec(readFileSync(resolve(process.cwd(), "migrations", "0008_member_bot_detection_observations.sql"), "utf8"));
            this.applyLegacyBotDetectionResetMigration();
        } catch (error) {
            this.database.close();
            throw error;
        }
    }

    close(): void {
        this.database.close();
    }

    private applyLegacyBotDetectionResetMigration(): void {
        this.database.exec("BEGIN IMMEDIATE");
        try {
            const applied = this.database.prepare("SELECT version FROM schema_migrations WHERE version = ?")
                .get(LEGACY_BOT_DETECTION_RESET_MIGRATION_VERSION) as { version: number } | undefined;
            if (!applied) {
                this.database.prepare(`
                    UPDATE member_bot_state
                    SET auto_bot = 0, detection_marks = 0, last_detection_at = NULL
                `).run();
                this.database.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
                    .run(LEGACY_BOT_DETECTION_RESET_MIGRATION_VERSION, this.now());
            }
            this.database.exec("COMMIT");
        } catch (error) {
            try { this.database.exec("ROLLBACK"); } catch { /* Preserve the migration error. */ }
            throw error;
        }
    }

    private getActiveDetectionSummary(groupOpenid: string, memberOpenid: string, at: number): ActiveDetectionSummary {
        return this.database.prepare(`
            SELECT COUNT(*) AS count, MAX(created_at) AS last_detection_at
            FROM member_bot_detection_events
            WHERE group_openid = ? AND member_openid = ? AND expires_at > ?
        `).get(groupOpenid, memberOpenid, at) as unknown as ActiveDetectionSummary;
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

    async getMemberBotState(groupOpenid: string, memberOpenid: string): Promise<MemberBotState> {
        const row = this.database.prepare(`
            SELECT group_openid, member_openid, platform_bot, manual_bot, auto_bot, detection_marks,
                last_detection_at, created_at, updated_at
            FROM member_bot_state WHERE group_openid = ? AND member_openid = ?
        `).get(groupOpenid, memberOpenid) as MemberBotStateRow | undefined;
        const state = row ? rowToBotState(row) : defaultBotState(groupOpenid, memberOpenid);
        const summary = this.getActiveDetectionSummary(groupOpenid, memberOpenid, this.now());
        return { ...state, detectionMarks: summary.count, lastDetectionAt: summary.last_detection_at, autoBot: false };
    }

    async setPlatformBot(groupOpenid: string, memberOpenid: string, enabled: boolean, at: number): Promise<MemberBotState> {
        this.database.prepare(`
            INSERT INTO member_bot_state (group_openid, member_openid, platform_bot, manual_bot, auto_bot,
                detection_marks, last_detection_at, created_at, updated_at)
            VALUES (?, ?, ?, 0, 0, 0, NULL, ?, ?)
            ON CONFLICT (group_openid, member_openid) DO UPDATE SET
                platform_bot = excluded.platform_bot, updated_at = excluded.updated_at
        `).run(groupOpenid, memberOpenid, enabled ? 1 : 0, at, at);
        return this.getMemberBotState(groupOpenid, memberOpenid);
    }

    async setManualBot(groupOpenid: string, memberOpenid: string, enabled: boolean, at: number): Promise<MemberBotState> {
        this.database.prepare(`
            INSERT INTO member_bot_state (group_openid, member_openid, platform_bot, manual_bot, auto_bot,
                detection_marks, last_detection_at, created_at, updated_at)
            VALUES (?, ?, 0, ?, 0, 0, NULL, ?, ?)
            ON CONFLICT (group_openid, member_openid) DO UPDATE SET
                manual_bot = excluded.manual_bot, updated_at = excluded.updated_at
        `).run(groupOpenid, memberOpenid, enabled ? 1 : 0, at, at);
        return this.getMemberBotState(groupOpenid, memberOpenid);
    }

    async addDetectionEvidence(evidence: AddMemberBotDetectionEvidence): Promise<MemberBotDetectionEvidence> {
        const createdAt = evidence.createdAt ?? this.now();
        const expiresAt = evidence.expiresAt ?? createdAt + MEMBER_BOT_DETECTION_EVIDENCE_TTL_MS;
        const row = this.database.prepare(`
            INSERT INTO member_bot_detection_events
                (group_openid, member_openid, signal_type, created_at, expires_at)
            VALUES (?, ?, ?, ?, ?)
            RETURNING id, group_openid, member_openid, signal_type, created_at, expires_at
        `).get(evidence.groupOpenid, evidence.memberOpenid, evidence.signalType, createdAt, expiresAt) as DetectionEvidenceRow | undefined;
        if (!row) throw new Error("Unable to add member Bot detection evidence");
        return rowToDetectionEvidence(row);
    }

    async addDetectionEvidenceIfCooldownElapsed(
        evidence: AddMemberBotDetectionEvidence,
        cooldownMs: number,
    ): Promise<MemberBotDetectionEvidence | null> {
        const createdAt = evidence.createdAt ?? this.now();
        const expiresAt = evidence.expiresAt ?? createdAt + MEMBER_BOT_DETECTION_EVIDENCE_TTL_MS;
        const row = this.database.prepare(`
            INSERT INTO member_bot_detection_events
                (group_openid, member_openid, signal_type, created_at, expires_at)
            SELECT ?, ?, ?, ?, ?
            WHERE NOT EXISTS (
                SELECT 1 FROM member_bot_detection_events
                WHERE group_openid = ? AND member_openid = ? AND signal_type = ? AND created_at > ?
            )
            RETURNING id, group_openid, member_openid, signal_type, created_at, expires_at
        `).get(evidence.groupOpenid, evidence.memberOpenid, evidence.signalType, createdAt, expiresAt,
            evidence.groupOpenid, evidence.memberOpenid, evidence.signalType, createdAt - cooldownMs) as DetectionEvidenceRow | undefined;
        return row ? rowToDetectionEvidence(row) : null;
    }

    async listActiveDetectionEvidence(groupOpenid: string, memberOpenid: string, at = this.now()): Promise<MemberBotDetectionEvidence[]> {
        const rows = this.database.prepare(`
            SELECT id, group_openid, member_openid, signal_type, created_at, expires_at
            FROM member_bot_detection_events
            WHERE group_openid = ? AND member_openid = ? AND expires_at > ?
            ORDER BY created_at, id
        `).all(groupOpenid, memberOpenid, at) as unknown as DetectionEvidenceRow[];
        return rows.map(rowToDetectionEvidence);
    }

    async getActiveDetectionCount(groupOpenid: string, memberOpenid: string, at = this.now()): Promise<number> {
        const row = this.database.prepare(`
            SELECT COUNT(*) AS count FROM member_bot_detection_events
            WHERE group_openid = ? AND member_openid = ? AND expires_at > ?
        `).get(groupOpenid, memberOpenid, at) as { count: number };
        return row.count;
    }

    async clearDetectionEvidence(groupOpenid: string, memberOpenid: string): Promise<MemberBotState> {
        this.database.prepare(`
            DELETE FROM member_bot_detection_events WHERE group_openid = ? AND member_openid = ?
        `).run(groupOpenid, memberOpenid);
        this.database.prepare(`
            DELETE FROM member_bot_detection_observations WHERE group_openid = ? AND member_openid = ?
        `).run(groupOpenid, memberOpenid);
        return this.getMemberBotState(groupOpenid, memberOpenid);
    }

    async recordDetectionObservation(observation: MemberBotDetectionObservation): Promise<boolean> {
        const result = this.database.prepare(`
            INSERT OR IGNORE INTO member_bot_detection_observations
                (group_openid, member_openid, message_id, normalized_text, observed_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(observation.groupOpenid, observation.memberOpenid, observation.messageId,
            observation.normalizedText, observation.observedAt, observation.expiresAt);
        return result.changes === 1;
    }

    async listRecentDetectionObservations(
        groupOpenid: string,
        memberOpenid: string,
        since: number,
        through: number,
        at = this.now(),
    ): Promise<MemberBotDetectionObservation[]> {
        const rows = this.database.prepare(`
            SELECT group_openid, member_openid, message_id, normalized_text, observed_at, expires_at
            FROM member_bot_detection_observations
            WHERE group_openid = ? AND member_openid = ? AND observed_at >= ? AND observed_at <= ? AND expires_at > ?
            ORDER BY observed_at, message_id
        `).all(groupOpenid, memberOpenid, since, through, at) as unknown as DetectionObservationRow[];
        return rows.map(rowToDetectionObservation);
    }

    async pruneExpiredDetectionEvidence(at = this.now()): Promise<void> {
        this.database.prepare("DELETE FROM member_bot_detection_events WHERE expires_at <= ?").run(at);
        this.database.prepare("DELETE FROM member_bot_detection_observations WHERE expires_at <= ?").run(at);
    }

    async listMarkedBots(): Promise<GroupMember[]> {
        const at = this.now();
        const rows = this.database.prepare(`${groupMemberSelect}
            WHERE s.platform_bot = 1 OR s.manual_bot = 1
            ORDER BY m.last_seen_at DESC, m.group_openid, m.member_openid
        `).all(at, at) as unknown as GroupMemberRow[];
        return rows.map(rowToGroupMember);
    }

    async listGroupMembers(groupOpenid: string): Promise<GroupMember[]> {
        const at = this.now();
        const rows = this.database.prepare(`${groupMemberSelect}
            WHERE m.group_openid = ? ORDER BY m.last_seen_at DESC, m.member_openid
        `).all(at, at, groupOpenid) as unknown as GroupMemberRow[];
        return rows.map(rowToGroupMember);
    }

    async findGroupMember(groupOpenid: string, memberOpenid: string): Promise<GroupMember | null> {
        const at = this.now();
        const row = this.database.prepare(`${groupMemberSelect}
            WHERE m.group_openid = ? AND m.member_openid = ?
        `).get(at, at, groupOpenid, memberOpenid) as GroupMemberRow | undefined;
        if (!row) return null;
        return { ...rowToGroupMember(row), activeDetectionEvidence: await this.listActiveDetectionEvidence(groupOpenid, memberOpenid, at) };
    }

    async wasLegacyAutomatedPeerImportCompleted(): Promise<boolean> {
        return this.database.prepare("SELECT value FROM runtime_state WHERE key = ?")
            .get("legacy_automated_peer_ids_imported")?.value === "1";
    }

    async markLegacyAutomatedPeerImportCompleted(at: number): Promise<void> {
        this.database.prepare(`
            INSERT INTO runtime_state (key, value, updated_at) VALUES (?, '1', ?)
            ON CONFLICT (key) DO UPDATE SET value = '1', updated_at = excluded.updated_at
        `).run("legacy_automated_peer_ids_imported", at);
    }

    async ensureGroup(groupOpenid: string, at: number, displayName?: string): Promise<GroupSettings> {
        this.database.prepare(`
            INSERT INTO group_settings (group_openid, replies_enabled, first_seen_at, last_seen_at, display_name, updated_at)
            VALUES (?, 1, ?, ?, ?, ?)
            ON CONFLICT (group_openid) DO UPDATE SET
                last_seen_at = MAX(group_settings.last_seen_at, excluded.last_seen_at),
                display_name = COALESCE(excluded.display_name, group_settings.display_name),
                updated_at = excluded.updated_at
        `).run(groupOpenid, at, at, cleanGroupName(displayName), at);
        const settings = await this.getGroupSettings(groupOpenid);
        if (!settings) throw new Error("Unable to read ensured group settings");
        return settings;
    }

    async getGroupSettings(groupOpenid: string): Promise<GroupSettings | null> {
        const row = this.database.prepare(`
            SELECT s.group_openid, s.replies_enabled, s.first_seen_at, s.last_seen_at, s.display_name, s.updated_at,
                (SELECT COUNT(*) FROM group_members m WHERE m.group_openid = s.group_openid) AS member_count
            FROM group_settings s WHERE s.group_openid = ?
        `).get(groupOpenid) as GroupSettingsRow | undefined;
        return row ? rowToGroupSettings(row) : null;
    }

    async setGroupRepliesEnabledForGroup(groupOpenid: string, enabled: boolean, at: number): Promise<GroupSettings | null> {
        const result = this.database.prepare(`
            UPDATE group_settings SET replies_enabled = ?, updated_at = ? WHERE group_openid = ?
        `).run(enabled ? 1 : 0, at, groupOpenid);
        if (result.changes === 0) return null;
        return this.getGroupSettings(groupOpenid);
    }

    async listGroups(): Promise<GroupSettings[]> {
        const rows = this.database.prepare(`
            SELECT s.group_openid, s.replies_enabled, s.first_seen_at, s.last_seen_at, s.display_name, s.updated_at,
                (SELECT COUNT(*) FROM group_members m WHERE m.group_openid = s.group_openid) AS member_count
            FROM group_settings s ORDER BY s.last_seen_at DESC, s.group_openid
        `).all() as unknown as GroupSettingsRow[];
        return rows.map(rowToGroupSettings);
    }

    async getGroupRepliesEnabled(): Promise<boolean> {
        const row = this.database.prepare(
            "SELECT value FROM runtime_state WHERE key = 'group_replies_enabled'",
        ).get() as { value?: string } | undefined;
        return row?.value === "1";
    }

    async setGroupRepliesEnabled(enabled: boolean): Promise<void> {
        this.database.prepare(`
            INSERT INTO runtime_state (key, value, updated_at)
            VALUES ('group_replies_enabled', ?, ?)
            ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `).run(enabled ? "1" : "0", Date.now());
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

interface ActiveDetectionSummary {
    count: number;
    last_detection_at: number | null;
}

interface DetectionEvidenceRow {
    id: number;
    group_openid: string;
    member_openid: string;
    signal_type: string;
    created_at: number;
    expires_at: number;
}

interface DetectionObservationRow {
    group_openid: string;
    member_openid: string;
    message_id: string;
    normalized_text: string;
    observed_at: number;
    expires_at: number;
}

interface GroupMemberRow extends MemberRow, MemberBotStateRow {}

const groupMemberSelect = `
    SELECT m.group_openid, m.member_openid, m.username, m.role, m.first_seen_at, m.last_seen_at, m.updated_at,
        COALESCE(s.platform_bot, 0) AS platform_bot, COALESCE(s.manual_bot, 0) AS manual_bot,
        0 AS auto_bot,
        (SELECT COUNT(*) FROM member_bot_detection_events e
            WHERE e.group_openid = m.group_openid AND e.member_openid = m.member_openid AND e.expires_at > ?) AS detection_marks,
        (SELECT MAX(e.created_at) FROM member_bot_detection_events e
            WHERE e.group_openid = m.group_openid AND e.member_openid = m.member_openid AND e.expires_at > ?) AS last_detection_at,
        COALESCE(s.created_at, m.first_seen_at) AS created_at,
        COALESCE(s.updated_at, m.updated_at) AS bot_updated_at
    FROM group_members m LEFT JOIN member_bot_state s
        ON s.group_openid = m.group_openid AND s.member_openid = m.member_openid`;

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

function defaultBotState(groupOpenid: string, memberOpenid: string): MemberBotState {
    return { groupOpenid, memberOpenid, platformBot: false, manualBot: false, autoBot: false,
        detectionMarks: 0, lastDetectionAt: null, createdAt: 0, updatedAt: 0 };
}

function rowToBotState(row: MemberBotStateRow): MemberBotState {
    return {
        groupOpenid: row.group_openid,
        memberOpenid: row.member_openid,
        platformBot: row.platform_bot === 1,
        manualBot: row.manual_bot === 1,
        autoBot: false,
        detectionMarks: row.detection_marks,
        lastDetectionAt: row.last_detection_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function rowToGroupMember(row: GroupMemberRow): GroupMember {
    return {
        ...rowToMember(row),
        platformBot: row.platform_bot === 1,
        manualBot: row.manual_bot === 1,
        autoBot: false,
        detectionMarks: row.detection_marks,
        lastDetectionAt: row.last_detection_at,
    };
}

function rowToDetectionEvidence(row: DetectionEvidenceRow): MemberBotDetectionEvidence {
    return {
        id: row.id,
        groupOpenid: row.group_openid,
        memberOpenid: row.member_openid,
        signalType: row.signal_type,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
    };
}

function rowToDetectionObservation(row: DetectionObservationRow): MemberBotDetectionObservation {
    return {
        groupOpenid: row.group_openid,
        memberOpenid: row.member_openid,
        messageId: row.message_id,
        normalizedText: row.normalized_text,
        observedAt: row.observed_at,
        expiresAt: row.expires_at,
    };
}
