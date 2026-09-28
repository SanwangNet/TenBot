import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { QQBot } from "@tencent-connect/qqbot-nodejs";
import type { NormalizedQqMessage } from "../src/qq/message/normalize-message.js";

import { routeCommand } from "../src/commands/router.js";
import { D1MemberRepository, type D1MemberDatabase } from "../src/members/d1-repository.js";
import { MemoryMemberRepository } from "../src/members/memory-repository.js";
import type { KnownMember } from "../src/members/repository.js";
import { SqliteMemberRepository } from "../src/members/sqlite-repository.js";
import { importLegacyAutomatedPeerIds } from "../src/members/legacy-peer-import.js";
import { GroupReplyControl, isConfiguredBotAdmin } from "../src/runtime/group-reply-control.js";
import { toOpaqueMemberDisplayId, toOpaqueMemberHash } from "../src/members/opaque-member-id.js";
import { createTenBotControl } from "../src/control/tenbot-control.js";
import type { RuntimeStatus } from "../src/control/runtime-status.js";
import type { PublicConfig } from "../src/config/config-types.js";
import {
    buildKnownMembersContext, configureMemberRepository, rememberKnownMember, MAX_MODEL_KNOWN_MEMBERS,
} from "../src/qq/conversation/known-members.js";
import { renderStructuredMentions } from "../src/qq/reply/mentions.js";

const directory = await mkdtemp(join(tmpdir(), "qq-member-db-"));
const sqlite = new SqliteMemberRepository(join(directory, "members.db"));
after(async () => {
    sqlite.close();
    await rm(directory, { recursive: true, force: true });
});

function member(groupOpenid: string, memberOpenid: string, username: string, role?: string): KnownMember {
    return { groupOpenid, memberOpenid, username, role, firstSeenAt: 10, lastSeenAt: 10, updatedAt: 10 };
}

function message(groupId: string, author: Record<string, unknown>): NormalizedQqMessage {
    return {
        kind: "group", groupId, author, authorIsBot: false, mentions: [],
        content: "", displayContent: "", replyTarget: { targetId: groupId },
    } as unknown as NormalizedQqMessage;
}

test("SQLite migration and UPSERT preserve first seen while updating name, role, and last seen", async () => {
    await sqlite.upsertMember(member("group-a", "person-1", "芷", "member"));
    const inserted = await sqlite.findByOpenid("group-a", "person-1");
    assert.equal(inserted?.username, "芷");
    assert.equal(inserted?.firstSeenAt, 10);

    await sqlite.upsertMember({ ...member("group-a", "person-1", "芷芷", "admin"), firstSeenAt: 20,
        lastSeenAt: 20, updatedAt: 20 });
    const updated = await sqlite.findByOpenid("group-a", "person-1");
    assert.equal(updated?.username, "芷芷");
    assert.equal(updated?.role, "admin");
    assert.equal(updated?.firstSeenAt, 10);
    assert.equal(updated?.lastSeenAt, 20);
    assert.equal(updated?.updatedAt, 20);
    assert.equal((await sqlite.listByGroup("group-a")).length, 1);

    await sqlite.upsertMember({ ...member("group-a", "person-1", "芷芷"), lastSeenAt: 30, updatedAt: 30 });
    assert.equal((await sqlite.findByOpenid("group-a", "person-1"))?.role, "admin");
});

test("global group reply state defaults off and survives repository restarts without migration overwrite", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "tenbot-runtime-state-"));
    const statePath = join(stateDirectory, "runtime.db");
    let repository = new SqliteMemberRepository(statePath);
    try {
        assert.equal(await repository.getGroupRepliesEnabled(), false);
        await repository.setGroupRepliesEnabled(true);
        repository.close();
        repository = new SqliteMemberRepository(statePath);
        assert.equal(await repository.getGroupRepliesEnabled(), true);
        await repository.setGroupRepliesEnabled(false);
        repository.close();
        repository = new SqliteMemberRepository(statePath);
        assert.equal(await repository.getGroupRepliesEnabled(), false);
    } finally {
        repository.close();
        await rm(stateDirectory, { recursive: true, force: true });
    }
});

test("group reply settings default on, persist, and cancel only the disabled group", async () => {
    const groupA = `group-a-${randomUUID()}`;
    const groupB = `group-b-${randomUUID()}`;
    const at = 1_700_000_000_000;
    const newGroup = await sqlite.ensureGroup(groupA, at, "测试群 A");
    await sqlite.ensureGroup(groupB, at + 1, "测试群 B");
    const legacyGroup = `legacy-group-${randomUUID()}`;
    await sqlite.upsertMember(member(legacyGroup, "legacy-member", "旧成员"));
    assert.equal(newGroup.repliesEnabled, true);
    assert.equal(newGroup.displayName, "测试群 A");

    await sqlite.setGroupRepliesEnabled(true);
    const control = new GroupReplyControl(sqlite, sqlite);
    await control.initialize();
    assert.equal(control.getGroupRepliesEnabledForGroup(groupA), true, "global and new group gates allow replies");
    assert.equal(control.getGroupRepliesEnabledForGroup(groupB), true);

    const cancelled: Array<string | undefined> = [];
    control.registerPendingWorkCanceller((groupOpenid) => { cancelled.push(groupOpenid); });
    const changed = await control.setGroupRepliesEnabledForGroup(groupA, false, "admin");
    assert.deepEqual(changed, { ok: true, changed: true });
    assert.equal(control.getGroupRepliesEnabledForGroup(groupA), false);
    assert.equal(control.getGroupRepliesEnabledForGroup(groupB), true);
    assert.deepEqual(cancelled, [groupA]);

    const reopened = new SqliteMemberRepository(join(directory, "members.db"));
    try {
        assert.equal((await reopened.getGroupSettings(groupA))?.repliesEnabled, false);
        assert.equal((await reopened.getGroupSettings(groupB))?.repliesEnabled, true);
        assert.equal((await reopened.getGroupSettings(legacyGroup))?.repliesEnabled, true,
            "migration defaults groups with existing members to enabled");
    } finally { reopened.close(); }

    await control.setGroupRepliesEnabled(false, "admin");
    assert.equal(control.getGroupRepliesEnabledForGroup(groupB), false, "the global gate remains the master switch");
    assert.deepEqual(cancelled, [groupA, undefined], "global shutdown cancels all group work");
});

test("group setting load or observation failures fail closed even when the global gate is enabled", async () => {
    const control = new GroupReplyControl({
        async getGroupRepliesEnabled() { return true; },
        async setGroupRepliesEnabled() {},
    }, {
        async ensureGroup() { throw new Error("group settings unavailable"); },
        async getGroupSettings() { throw new Error("group settings unavailable"); },
        async setGroupRepliesEnabledForGroup() { throw new Error("group settings unavailable"); },
        async listGroups() { throw new Error("group settings unavailable"); },
    });
    await control.initialize();
    assert.equal(control.getGroupRepliesEnabled(), true);
    assert.equal(control.getGroupRepliesEnabledForGroup("group-a"), false);
    assert.equal(await control.observeGroup("group-a"), false);
    assert.equal(control.getGroupRepliesEnabledForGroup("group-a"), false);
});

test("manual, platform, automatic Bot state and detector marks persist independently per group", async () => {
    const groupA = `bot-group-a-${randomUUID()}`;
    const groupB = `bot-group-b-${randomUUID()}`;
    const memberOpenid = `same-member-${randomUUID()}`;
    const at = 1_700_001_000_000;
    await sqlite.upsertMember(member(groupA, memberOpenid, "Bot 甲"));
    await sqlite.upsertMember(member(groupB, memberOpenid, "Bot 乙"));

    await sqlite.setManualBot(groupA, memberOpenid, true, at);
    await sqlite.setPlatformBot(groupB, memberOpenid, true, at);
    for (let mark = 1; mark <= 4; mark++) {
        const state = await sqlite.incrementDetectionMark(groupA, memberOpenid, at + mark, 5);
        assert.equal(state.detectionMarks, mark);
        assert.equal(state.autoBot, false, "four marks do not yet mark an account as automated");
    }
    const fifth = await sqlite.incrementDetectionMark(groupA, memberOpenid, at + 5, 5);
    assert.equal(fifth.autoBot, true, "threshold crossing persists auto_bot atomically with the fifth mark");
    assert.equal((await sqlite.getMemberBotState(groupA, memberOpenid)).manualBot, true);
    assert.deepEqual(await sqlite.getMemberBotState(groupB, memberOpenid), {
        groupOpenid: groupB, memberOpenid, platformBot: true, manualBot: false, autoBot: false,
        detectionMarks: 0, lastDetectionAt: null, createdAt: at, updatedAt: at,
    });

    const reopened = new SqliteMemberRepository(join(directory, "members.db"));
    try {
        const reopenedA = await reopened.getMemberBotState(groupA, memberOpenid);
        assert.equal(reopenedA.detectionMarks, 5);
        assert.equal(reopenedA.autoBot, true);
        assert.equal(reopenedA.manualBot, true);
        assert.equal((await reopened.findGroupMember(groupA, memberOpenid))?.username, "Bot 甲");
        assert.equal((await reopened.findGroupMember(groupB, memberOpenid))?.platformBot, true);

        const cleared = await reopened.resetDetectionMarks(groupA, memberOpenid, at + 6);
        assert.equal(cleared.detectionMarks, 0);
        assert.equal(cleared.autoBot, false);
        assert.equal(cleared.manualBot, true, "clearing detections does not remove a manual Bot flag");
        assert.equal((await reopened.getMemberBotState(groupB, memberOpenid)).platformBot, true,
            "clearing one group's marks does not affect another group");
    } finally { reopened.close(); }
});

test("legacy AUTOMATED_PEER_IDS imports only IDs mapped to persisted groups once", async () => {
    const groupA = `legacy-import-a-${randomUUID()}`;
    const groupB = `legacy-import-b-${randomUUID()}`;
    const memberOpenid = `legacy-member-${randomUUID()}`;
    await sqlite.upsertMember(member(groupA, memberOpenid, "旧 Bot A"));
    await sqlite.upsertMember(member(groupB, memberOpenid, "旧 Bot B"));
    const result = await importLegacyAutomatedPeerIds(sqlite, [memberOpenid, "unmapped-id"]);
    assert.deepEqual(result, { imported: 2, unmatched: 1, skipped: false });
    assert.equal((await sqlite.getMemberBotState(groupA, memberOpenid)).manualBot, true);
    assert.equal((await sqlite.getMemberBotState(groupB, memberOpenid)).manualBot, true);
    await sqlite.setManualBot(groupA, memberOpenid, false, Date.now());
    assert.equal((await importLegacyAutomatedPeerIds(sqlite, [memberOpenid])).skipped, true);
    assert.equal((await sqlite.getMemberBotState(groupA, memberOpenid)).manualBot, false,
        "the one-time importer never re-enables a manually removed legacy flag");
});

test("admin authorization uses the opaque stable member OpenID and accepts display or full hash", () => {
    const memberOpenid = "stable-member-openid";
    const displayId = toOpaqueMemberDisplayId(memberOpenid);
    assert.equal(isConfiguredBotAdmin(memberOpenid, [` ${displayId.toLowerCase()} `]), true);
    assert.equal(isConfiguredBotAdmin(memberOpenid, [toOpaqueMemberHash(memberOpenid)]), true);
    assert.equal(isConfiguredBotAdmin("different-member", [displayId]), false);
    assert.equal(isConfiguredBotAdmin(undefined, [displayId]), false);
});

test("failed state persistence preserves the old enabled state without canceling work", async () => {
    const control = new GroupReplyControl({
        async getGroupRepliesEnabled() { return true; },
        async setGroupRepliesEnabled() { throw new Error("disk failure"); },
    }, new MemoryMemberRepository());
    await control.initialize();
    let cancellations = 0;
    control.registerPendingWorkCanceller(() => { cancellations++; });
    const result = await control.setGroupRepliesEnabled(false, "4D53C611");
    assert.deepEqual(result, { ok: false, changed: false });
    assert.equal(control.getGroupRepliesEnabled(), true);
    assert.equal(cancellations, 0);
});

test("group reply state load failure fails closed", async () => {
    const control = new GroupReplyControl({
        async getGroupRepliesEnabled() { throw new Error("database unavailable"); },
        async setGroupRepliesEnabled() {},
    }, new MemoryMemberRepository());
    assert.equal(await control.initialize(), false);
    assert.equal(control.getGroupRepliesEnabled(), false);
});

test("concurrent group reply commands persist in order and publish the final state", async () => {
    let persisted = false;
    let releaseEnable!: () => void;
    const enableWait = new Promise<void>((resolve) => { releaseEnable = resolve; });
    const writes: boolean[] = [];
    const control = new GroupReplyControl({
        async getGroupRepliesEnabled() { return persisted; },
        async setGroupRepliesEnabled(enabled) {
            writes.push(enabled);
            if (enabled) await enableWait;
            persisted = enabled;
        },
    }, new MemoryMemberRepository());
    await control.initialize();
    const enable = control.setGroupRepliesEnabled(true, "4D53C611");
    await new Promise((resolve) => setImmediate(resolve));
    const disable = control.setGroupRepliesEnabled(false, "4D53C611");
    releaseEnable();
    const [enabledResult, disabledResult] = await Promise.all([enable, disable]);
    assert.deepEqual(writes, [true, false]);
    assert.deepEqual(enabledResult, { ok: true, changed: true });
    assert.deepEqual(disabledResult, { ok: true, changed: true });
    assert.equal(persisted, false);
    assert.equal(control.getGroupRepliesEnabled(), false);
});

test("SQLite keeps groups separate and returns every duplicate nickname", async () => {
    await sqlite.upsertMember(member("group-a", "person-2", "同名"));
    await sqlite.upsertMember(member("group-a", "person-3", "同名"));
    await sqlite.upsertMember(member("group-b", "person-1", "同名"));
    const matches = await sqlite.findByUsername("group-a", "同名");
    assert.deepEqual(matches.map((item) => item.memberOpenid), ["person-2", "person-3"]);
    assert.deepEqual((await sqlite.listByGroup("group-b")).map((item) => item.memberOpenid), ["person-1"]);
    assert.equal(await sqlite.findByOpenid("group-b", "person-2"), null);
});

test("group member names and full IDs survive reopening SQLite and are available to authenticated control", async () => {
    await sqlite.upsertMember({ ...member("summary-group-a", "member-secret", "旧昵称"), lastSeenAt: 10, updatedAt: 10 });
    await sqlite.upsertMember({ ...member("summary-group-b", "member-secret", "新昵称", "admin"), lastSeenAt: 30, updatedAt: 30 });
    await sqlite.setManualBot("summary-group-b", "member-secret", true, 30);

    const reopened = new SqliteMemberRepository(join(directory, "members.db"));
    try {
        const inGroupA = await reopened.findGroupMember("summary-group-a", "member-secret");
        const inGroupB = await reopened.findGroupMember("summary-group-b", "member-secret");
        assert.equal(inGroupA?.username, "旧昵称");
        assert.equal(inGroupB?.username, "新昵称");
        assert.equal(inGroupB?.role, "admin");
        assert.equal(inGroupB?.memberOpenid, "member-secret");
        assert.equal(inGroupB?.manualBot, true);

        const control = createTenBotControl({
            getStatus: () => ({
                qq: "disconnected", provider: { id: "gpt", model: "offline", webSearch: false, configured: false },
                groupRepliesEnabled: false,
                activeCycles: 0, contextConversations: 0,
                memes: { count: 0, revision: 0, loadedAt: "now" },
                prompt: { provider: "gpt", revision: 0, loadedAt: "now" }, shuttingDown: false,
            } satisfies RuntimeStatus),
            getConfig: () => ({} as PublicConfig),
            async updateConfig() { return { ok: true, requiresRestart: false, changedFields: [], message: "" }; },
            async getGroups() { return await reopened.listGroups(); },
            async setGroupRepliesEnabledForGroup() { return { ok: true, changed: false }; },
            async getMarkedBots() { return reopened.listMarkedBots(); },
            async getGroupMembers(groupOpenid) { return reopened.listGroupMembers(groupOpenid); },
            async getGroupMember(groupOpenid, memberOpenid) { return reopened.findGroupMember(groupOpenid, memberOpenid); },
            async setMemberManualBot(groupOpenid, memberOpenid, enabled) { return reopened.setManualBot(groupOpenid, memberOpenid, enabled, Date.now()); },
            async clearMemberDetection(groupOpenid, memberOpenid) { return reopened.resetDetectionMarks(groupOpenid, memberOpenid, Date.now()); },
            async reloadPrompt() { return { ok: true, message: "", loadedAt: "now" }; },
            async reloadReplyJudgePrompt() { return { ok: true, message: "", loadedAt: "now" }; },
            async reloadMemes() { return { ok: true, message: "", loadedAt: "now" }; },
            async getEditorResource() { throw new Error("unused"); },
            async saveEditorResource() { throw new Error("unused"); },
            async shutdown() {},
            subscribeLogs: () => () => undefined,
        });
        assert.equal((await control.getGroupMember("summary-group-b", "member-secret"))?.username, "新昵称");
        assert.equal((await control.getMarkedBots()).some((item) => item.memberOpenid === "member-secret" && item.groupOpenid === "summary-group-b"), true);
    } finally {
        reopened.close();
    }
});

test("service persists author and platform Bot identity, and resolves only unique human names", async () => {
    const repository = new MemoryMemberRepository();
    configureMemberRepository(repository);
    const incoming = message("service-group", { member_openid: "author-1", username: "尘柒", member_role: "owner" });
    incoming.mentions = [
        { memberOpenid: "person-1", ids: ["person-1"], username: "芷", role: "member", isBot: false, isSelf: false },
        { memberOpenid: "bot-1", ids: ["bot-1"], username: "小尘", isBot: true, isSelf: true },
    ];
    await rememberKnownMember(incoming);
    assert.equal((await repository.findByOpenid("service-group", "author-1"))?.role, "owner");
    assert.equal((await repository.findByOpenid("service-group", "person-1"))?.username, "芷");
    assert.equal((await repository.findGroupMember("service-group", "bot-1"))?.platformBot, true);
    assert.match((await renderStructuredMentions(incoming, "你好", ["芷"])).sendText,
        /<qqbot-at-user id="person-1" \/>/);

    await rememberKnownMember(message("service-group", { member_openid: "person-2", username: "芷" }));
    assert.equal((await renderStructuredMentions(incoming, "你好", ["芷"])).sendText, "@芷 你好");
    const context = await buildKnownMembersContext(incoming);
    assert.match(context, /尘柒（群主）/);
    assert.doesNotMatch(context, /person-1|author-1|service-group/);

    await rememberKnownMember({ ...incoming, authorIsBot: true, author: { member_openid: "bot-2", username: "小尘" }, mentions: [] });
    assert.equal((await repository.findGroupMember("service-group", "bot-2"))?.platformBot, true);
});

test("main-model member context deduplicates IDs and keeps the 200 most recently active", async () => {
    const base = new MemoryMemberRepository();
    for (let index = 0; index < 205; index++) {
        await base.upsertMember({
            groupOpenid: "large-group",
            memberOpenid: "openid-secret-" + index,
            username: "member-" + index,
            role: index === 204 ? "admin" : "member",
            firstSeenAt: index,
            lastSeenAt: index,
            updatedAt: index,
        });
    }
    class DuplicateRepository extends MemoryMemberRepository {
        override async listByGroup(groupOpenid: string) {
            const members = await base.listByGroup(groupOpenid);
            const newest = members.find((member) => member.memberOpenid === "openid-secret-204")!;
            return [...members, { ...newest, username: "最新昵称", lastSeenAt: 206 }];
        }
        override async listGroupMembers(groupOpenid: string) {
            return Promise.all((await this.listByGroup(groupOpenid)).map(async (member) => ({
                ...member,
                ...await base.getMemberBotState(groupOpenid, member.memberOpenid),
            })));
        }
        override async findByOpenid(groupOpenid: string, memberOpenid: string) {
            return base.findByOpenid(groupOpenid, memberOpenid);
        }
        override async findByUsername(groupOpenid: string, username: string) {
            return base.findByUsername(groupOpenid, username);
        }
        override async upsertMember(member: KnownMember) {
            return base.upsertMember(member);
        }
        override async listAll() {
            return base.listAll();
        }
    }
    configureMemberRepository(new DuplicateRepository());
    const incoming = message("large-group", { member_openid: "other", username: "访客" });
    const context = await buildKnownMembersContext(incoming);
    const lines = context.split("<known_group_members>")[1]!.split("</known_group_members>")[0]!
        .split("\n").filter(Boolean);
    assert.equal(MAX_MODEL_KNOWN_MEMBERS, 200);
    assert.equal(lines.length, 200);
    assert.match(lines[0]!, /^最新昵称（管理员）/);
    assert.match(context, /member-5（成员）/);
    assert.doesNotMatch(context, /member-4（成员）/);
    assert.doesNotMatch(context, /openid-secret|firstSeenAt|updatedAt|groupCount/);
});

test("/members reads the configured repository for the current group", async () => {
    configureMemberRepository(sqlite);
    const sent: string[] = [];
    const bot = { sendText: async (_target: unknown, text: string) => { sent.push(text); } } as unknown as QQBot;
    const command = { ...message("group-b", {}), content: "/members", displayContent: "/members" };
    assert.equal(await routeCommand(bot, command), true);
    assert.deepEqual(sent, ["同名 (member)"]);
    configureMemberRepository(new MemoryMemberRepository());
});

test("D1 adapter binds parameters and maps rows through its minimal binding", async () => {
    const rows = new Map<string, Record<string, string | number | null>>();
    const statements: string[] = [];
    const database: D1MemberDatabase = {
        prepare(query) {
            statements.push(query);
            return {
                bind(...values) {
                    return {
                        async run() {
                            const [group, id, username, role, first, last, updated] = values;
                            const key = group + "/" + id;
                            const previous = rows.get(key);
                            rows.set(key, {
                                group_openid: group, member_openid: id, username, role: role ?? previous?.role ?? null,
                                first_seen_at: previous?.first_seen_at ?? first, last_seen_at: last, updated_at: updated,
                            });
                        },
                        async first<T>() {
                            return (rows.get(values[0] + "/" + values[1]) ?? null) as T | null;
                        },
                        async all<T>() {
                            const result = values.length === 0 ? [...rows.values()] : [...rows.values()].filter((row) => row.group_openid === values[0] &&
                                (values.length === 1 || row.username === values[1]));
                            return { results: result as T[] };
                        },
                    };
                },
            };
        },
    };
    const d1 = new D1MemberRepository(database);
    await d1.upsertMember(member("g", "m", "测试"));
    assert.equal((await d1.findByOpenid("g", "m"))?.username, "测试");
    assert.equal((await d1.findByUsername("g", "测试")).length, 1);
    assert.equal((await d1.listByGroup("g")).length, 1);
    assert.equal((await d1.listAll()).length, 1);
    assert.ok(statements.every((statement) => !statement.includes("测试")));
});
