import assert from "node:assert/strict";
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
import { summarizeKnownMembers } from "../src/control/known-members.js";
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

test("SQLite keeps groups separate and returns every duplicate nickname", async () => {
    await sqlite.upsertMember(member("group-a", "person-2", "同名"));
    await sqlite.upsertMember(member("group-a", "person-3", "同名"));
    await sqlite.upsertMember(member("group-b", "person-1", "同名"));
    const matches = await sqlite.findByUsername("group-a", "同名");
    assert.deepEqual(matches.map((item) => item.memberOpenid), ["person-2", "person-3"]);
    assert.deepEqual((await sqlite.listByGroup("group-b")).map((item) => item.memberOpenid), ["person-1"]);
    assert.equal(await sqlite.findByOpenid("group-b", "person-2"), null);
});

test("known member summaries aggregate groups and survive reopening SQLite", async () => {
    assert.deepEqual(summarizeKnownMembers([]), []);
    await sqlite.upsertMember({ ...member("summary-group-a", "member-secret", "旧昵称"), lastSeenAt: 10, updatedAt: 10 });
    await sqlite.upsertMember({ ...member("summary-group-b", "member-secret", "新昵称", "admin"), lastSeenAt: 30, updatedAt: 30 });

    const reopened = new SqliteMemberRepository(join(directory, "members.db"));
    try {
        const rows = await reopened.listAll();
        const summary = summarizeKnownMembers(rows).find((item) => item.displayName === "新昵称");
        assert.ok(summary);
        assert.equal(summary.lastSeenAt, 30);
        assert.equal(summary.groupCount, 2);
        assert.deepEqual(summary.roles, ["admin"]);
        assert.doesNotMatch(JSON.stringify(summary), /member-secret|summary-group/);

        const control = createTenBotControl({
            getStatus: () => ({
                qq: "disconnected", provider: { id: "gpt", model: "offline", webSearch: false, configured: false },
                activeCycles: 0, contextConversations: 0,
                memes: { count: 0, revision: 0, loadedAt: "now" },
                prompt: { provider: "gpt", revision: 0, loadedAt: "now" }, shuttingDown: false,
            } satisfies RuntimeStatus),
            getConfig: () => ({} as PublicConfig),
            async updateConfig() { return { ok: true, requiresRestart: false, changedFields: [], message: "" }; },
            getAutomatedPeers: () => [],
            getRecentPeers: () => [],
            async getKnownMembers() { return summarizeKnownMembers(await reopened.listAll()); },
            async addAutomatedPeer() { return { ok: true, changed: false, message: "" }; },
            async removeAutomatedPeer() { return { ok: true, changed: false, message: "" }; },
            async reloadPrompt() { return { ok: true, message: "", loadedAt: "now" }; },
            async reloadReplyJudgePrompt() { return { ok: true, message: "", loadedAt: "now" }; },
            async reloadMemes() { return { ok: true, message: "", loadedAt: "now" }; },
            async getEditorResource() { throw new Error("unused"); },
            async saveEditorResource() { throw new Error("unused"); },
            async shutdown() {},
            subscribeLogs: () => () => undefined,
        });
        assert.equal((await control.getKnownMembers()).find((item) => item.displayName === "新昵称")?.groupCount, 2);
    } finally {
        reopened.close();
    }
});

test("service learns author and mentions, skips bot, and resolves only unique names", async () => {
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
    assert.equal(await repository.findByOpenid("service-group", "bot-1"), null);
    assert.match((await renderStructuredMentions(incoming, "你好", ["芷"])).sendText,
        /<qqbot-at-user id="person-1" \/>/);

    await rememberKnownMember(message("service-group", { member_openid: "person-2", username: "芷" }));
    assert.equal((await renderStructuredMentions(incoming, "你好", ["芷"])).sendText, "@芷 你好");
    const context = await buildKnownMembersContext(incoming);
    assert.match(context, /尘柒（群主）/);
    assert.doesNotMatch(context, /person-1|author-1|service-group/);

    await rememberKnownMember({ ...incoming, authorIsBot: true, author: { member_openid: "bot-2", username: "小尘" }, mentions: [] });
    assert.equal(await repository.findByOpenid("service-group", "bot-2"), null);
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
