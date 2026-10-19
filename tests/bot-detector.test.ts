import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
    BOT_DETECTOR_MAX_FUTURE_SKEW_MS,
    BOT_DETECTOR_MIN_REPEAT_SPAN_MS,
    BOT_DETECTOR_MIN_TEXT_CODEPOINTS,
    BOT_DETECTOR_REPEAT_REQUIRED_COUNT,
    BOT_DETECTOR_REPEAT_WINDOW_MS,
    BOT_DETECTOR_SIGNAL_COOLDOWN_MS,
    BotDetector,
} from "../src/members/bot-detector.js";
import { MEMBER_BOT_DETECTION_EVIDENCE_TTL_MS, MEMBER_BOT_DETECTION_OBSERVATION_TTL_MS } from "../src/members/detection-evidence.js";
import { D1MemberRepository, type D1MemberDatabase } from "../src/members/d1-repository.js";
import { MemoryMemberRepository } from "../src/members/memory-repository.js";
import type { KnownMember, MemberRepository } from "../src/members/repository.js";
import { SqliteMemberRepository } from "../src/members/sqlite-repository.js";
import { configureMemberRepository, getKnownMembers } from "../src/qq/conversation/known-members.js";

const OCTOBER_1 = Date.UTC(2026, 9, 1);

function member(groupOpenid: string, memberOpenid: string): KnownMember {
    return { groupOpenid, memberOpenid, username: memberOpenid, firstSeenAt: 1, lastSeenAt: 1, updatedAt: 1 };
}

function d1Adapter(database: DatabaseSync): D1MemberDatabase {
    return {
        prepare(query) {
            return {
                bind(...values) {
                    const statement = database.prepare(query);
                    return {
                        async run() { return statement.run(...values); },
                        async first<T>() { return (statement.get(...values) as T | undefined) ?? null; },
                        async all<T>() { return { results: statement.all(...values) as T[] }; },
                    };
                },
            };
        },
    };
}

async function applySqlMigrations(database: DatabaseSync, versions: number[]): Promise<void> {
    for (const version of versions) {
        const files: Record<number, string> = {
            1: "0001_group_members.sql",
            2: "0002_runtime_state.sql",
            4: "0004_group_settings.sql",
            5: "0005_member_bot_state.sql",
            6: "0006_member_bot_detection_events.sql",
            7: "0007_reset_legacy_bot_detection.sql",
            8: "0008_member_bot_detection_observations.sql",
        };
        database.exec(await readFile(resolve(process.cwd(), "migrations", files[version]!), "utf8"));
    }
}

test("a realistic run of short human chatter never creates suspicion evidence", async () => {
    let time = OCTOBER_1;
    const repository = new MemoryMemberRepository(() => time);
    await repository.upsertMember(member("group-a", "member-a"));
    const detector = new BotDetector(repository, () => time);
    const messages = ["草", "哈哈", "真的假的", "笑死", "我靠"];
    let sequence = 0;
    for (let round = 0; round < 40; round++) {
        for (const text of messages) {
            const result = await detector.observe({ groupOpenid: "group-a", memberOpenid: "member-a", text,
                eligibleText: true, platformBot: false, messageId: `human-${sequence}`, messageTimestamp: time });
            sequence++;
            assert.equal(result.markAdded, false);
            time += 1_000;
        }
    }
    const result = await repository.getMemberBotState("group-a", "member-a");
    assert.equal(result.detectionMarks, 0);
    assert.equal(result.autoBot, false);
    assert.equal(await repository.getActiveDetectionCount("group-a", "member-a"), 0);
});

test("conservative repeat thresholds are explicit and a matching batch yields one evidence item", async () => {
    assert.equal(BOT_DETECTOR_REPEAT_WINDOW_MS, 10 * 60 * 1000);
    assert.equal(BOT_DETECTOR_REPEAT_REQUIRED_COUNT, 3);
    assert.equal(BOT_DETECTOR_MIN_TEXT_CODEPOINTS, 12);
    assert.equal(BOT_DETECTOR_MIN_REPEAT_SPAN_MS, 60 * 1000);
    assert.equal(BOT_DETECTOR_SIGNAL_COOLDOWN_MS, 30 * 60 * 1000);
    assert.equal(MEMBER_BOT_DETECTION_EVIDENCE_TTL_MS, 7 * 24 * 60 * 60 * 1000);
    assert.equal(MEMBER_BOT_DETECTION_OBSERVATION_TTL_MS, 7 * 24 * 60 * 60 * 1000);
    assert.equal(BOT_DETECTOR_MAX_FUTURE_SKEW_MS, 5 * 60 * 1000);

    let time = OCTOBER_1;
    const repository = new MemoryMemberRepository(() => time);
    await repository.upsertMember(member("group-a", "member-a"));
    const detector = new BotDetector(repository, () => time);
    const text = "服务器每天都能准确回复普通人的消息";
    const results = [];
    for (const [index, offset] of [0, 30_000, 60_000, 90_000, 120_000, 150_000].entries()) {
        time = OCTOBER_1 + offset;
        results.push(await detector.observe({ groupOpenid: "group-a", memberOpenid: "member-a", text,
            eligibleText: true, platformBot: false, messageId: `repeat-${index}`, messageTimestamp: time }));
    }
    assert.deepEqual(results.map((result) => result.markAdded), [false, false, true, false, false, false],
        "one continuous copy batch adds one suspicion item, not one item per message");
    const evidence = await repository.listActiveDetectionEvidence("group-a", "member-a");
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0]?.signalType, "repeated_text");
    assert.equal(evidence[0]?.expiresAt, OCTOBER_1 + 60_000 + MEMBER_BOT_DETECTION_EVIDENCE_TTL_MS);
    assert.equal((await repository.getMemberBotState("group-a", "member-a")).autoBot, false);
});

test("only eligible substantive normalized messages count and invalid timestamps are ignored", async () => {
    let time = OCTOBER_1;
    const repository = new MemoryMemberRepository(() => time);
    await repository.upsertMember(member("group-a", "member-a"));
    const detector = new BotDetector(repository, () => time);
    const text = "完全相同的长文本用于保守重复检测";
    const ignored = [
        { id: "emoji", text: "😀😀😀😀😀😀😀😀😀😀😀😀" },
        { id: "command", text: "/tenbot enable" },
        { id: "mention", text: text },
        { id: "attachment", text },
    ];
    for (const [index, item] of ignored.entries()) {
        await detector.observe({ groupOpenid: "group-a", memberOpenid: "member-a", text: item.text,
            eligibleText: index === 0, platformBot: false, messageId: item.id, messageTimestamp: time });
    }
    for (let index = 0; index < 3; index++) {
        time += 20_000;
        await detector.observe({ groupOpenid: "group-a", memberOpenid: "member-a", text,
            eligibleText: true, platformBot: false, messageId: `valid-${index}`, messageTimestamp: time });
    }
    assert.equal(await repository.getActiveDetectionCount("group-a", "member-a"), 0,
        "three matching messages span less than the 60-second minimum");
    time += 60_000;
    await detector.observe({ groupOpenid: "group-a", memberOpenid: "member-a", text,
        eligibleText: true, platformBot: false, messageId: "old", messageTimestamp: OCTOBER_1 - BOT_DETECTOR_REPEAT_WINDOW_MS - 1 });
    await detector.observe({ groupOpenid: "group-a", memberOpenid: "member-a", text,
        eligibleText: true, platformBot: false, messageId: "future", messageTimestamp: time + BOT_DETECTOR_MAX_FUTURE_SKEW_MS + 1 });
    assert.equal(await repository.getActiveDetectionCount("group-a", "member-a"), 0);
});

test("normalization, messageId deduplication, concurrency, and member/group isolation are safe", async () => {
    let time = OCTOBER_1;
    const repository = new MemoryMemberRepository(() => time);
    await repository.upsertMember(member("group-a", "member-a"));
    await repository.upsertMember(member("group-b", "member-a"));
    await repository.upsertMember(member("group-a", "member-b"));
    const detector = new BotDetector(repository, () => time);
    const text = "完全相同的长文本用于保守重复检测";
    const observations = [
        { id: "same-id", group: "group-a", member: "member-a", at: OCTOBER_1 },
        { id: "same-id", group: "group-a", member: "member-a", at: OCTOBER_1 + 30_000 },
        { id: "other-group", group: "group-b", member: "member-a", at: OCTOBER_1 + 30_000 },
        { id: "other-member", group: "group-a", member: "member-b", at: OCTOBER_1 + 30_000 },
        { id: "second", group: "group-a", member: "member-a", at: OCTOBER_1 + 30_000 },
        { id: "third", group: "group-a", member: "member-a", at: OCTOBER_1 + 60_000 },
    ];
    const results = await Promise.all(observations.map((item) => detector.observe({
        groupOpenid: item.group, memberOpenid: item.member, text: item.id === "second" ? ` ${text}  ` : text,
        eligibleText: true, platformBot: false, messageId: item.id, messageTimestamp: item.at,
    })));
    assert.equal(results.filter((result) => result.markAdded).length, 1);
    assert.equal(await repository.getActiveDetectionCount("group-a", "member-a"), 1);
    assert.equal(await repository.getActiveDetectionCount("group-b", "member-a"), 0);
    assert.equal(await repository.getActiveDetectionCount("group-a", "member-b"), 0);
    assert.equal(await repository.listRecentDetectionObservations("group-a", "member-a", OCTOBER_1,
        OCTOBER_1 + BOT_DETECTOR_REPEAT_WINDOW_MS).then((items) => items.length), 3,
    "duplicate messageId is not retained, while normalized whitespace makes matching exact");
});

test("clearing suspicion resets the repeat window and formal Bot state is never inferred", async () => {
    let time = OCTOBER_1;
    const repository = new MemoryMemberRepository(() => time);
    await repository.upsertMember(member("group-a", "manual"));
    await repository.upsertMember(member("group-a", "platform"));
    await repository.upsertMember(member("group-a", "plain"));
    await repository.setManualBot("group-a", "manual", true, time);
    await repository.setPlatformBot("group-a", "platform", true, time);
    const detector = new BotDetector(repository, () => time);
    const text = "完全相同的长文本用于保守重复检测";
    for (let index = 0; index < 2; index++) {
        time += 30_000;
        await detector.observe({ groupOpenid: "group-a", memberOpenid: "plain", text,
            eligibleText: true, platformBot: false, messageId: `plain-${index}`, messageTimestamp: time });
    }
    await repository.clearDetectionEvidence("group-a", "plain");
    time += 30_000;
    await detector.observe({ groupOpenid: "group-a", memberOpenid: "plain", text,
        eligibleText: true, platformBot: false, messageId: "plain-after-clear", messageTimestamp: time });
    for (const memberOpenid of ["manual", "platform"]) {
        for (let index = 0; index < 3; index++) {
            time += 30_000;
            await detector.observe({ groupOpenid: "group-a", memberOpenid, text,
                eligibleText: true, platformBot: false, messageId: `${memberOpenid}-${index}`, messageTimestamp: time });
        }
    }
    assert.equal(await repository.getActiveDetectionCount("group-a", "plain"), 0);
    assert.equal(await repository.getActiveDetectionCount("group-a", "manual"), 0);
    assert.equal(await repository.getActiveDetectionCount("group-a", "platform"), 0);
    assert.equal((await repository.getMemberBotState("group-a", "manual")).manualBot, true);
    assert.equal((await repository.getMemberBotState("group-a", "platform")).platformBot, true);
});

test("observation evidence leaves the member visible as a human and out of the formal Bot list", async () => {
    const repository = new MemoryMemberRepository(() => OCTOBER_1);
    await repository.upsertMember(member("group-a", "member-a"));
    for (let index = 0; index < 6; index++) {
        await repository.addDetectionEvidence({ groupOpenid: "group-a", memberOpenid: "member-a", signalType: "heuristic" });
    }
    configureMemberRepository(repository);
    try {
        const known = await getKnownMembers({ kind: "group", groupId: "group-a" } as never);
        assert.deepEqual(known.map((item) => item.memberOpenid), ["member-a"]);
        assert.deepEqual(await repository.listMarkedBots(), []);
        assert.equal((await repository.findGroupMember("group-a", "member-a"))?.detectionMarks, 6);
        assert.equal((await repository.getMemberBotState("group-a", "member-a")).autoBot, false);
    } finally { configureMemberRepository(new MemoryMemberRepository()); }
});

async function verifyEvidenceBehavior(
    repository: MemberRepository,
    setTime: (time: number) => void,
): Promise<void> {
    await repository.upsertMember(member("group-a", "same-member"));
    await repository.upsertMember(member("group-b", "same-member"));
    await repository.upsertMember(member("group-a", "another-member"));
    await repository.setManualBot("group-a", "same-member", true, OCTOBER_1);
    await repository.setPlatformBot("group-a", "same-member", true, OCTOBER_1);
    await repository.setPlatformBot("group-b", "same-member", true, OCTOBER_1);

    setTime(OCTOBER_1);
    const first = await repository.addDetectionEvidence({ groupOpenid: "group-a", memberOpenid: "same-member", signalType: "test" });
    assert.equal(first.expiresAt, OCTOBER_1 + MEMBER_BOT_DETECTION_EVIDENCE_TTL_MS);
    setTime(OCTOBER_1 + 2 * 24 * 60 * 60 * 1000);
    const second = await repository.addDetectionEvidence({ groupOpenid: "group-a", memberOpenid: "same-member", signalType: "test" });
    setTime(OCTOBER_1 + 4 * 24 * 60 * 60 * 1000);
    const third = await repository.addDetectionEvidence({ groupOpenid: "group-a", memberOpenid: "same-member", signalType: "test" });
    await repository.addDetectionEvidence({ groupOpenid: "group-b", memberOpenid: "same-member", signalType: "other-group" });

    assert.equal(await repository.getActiveDetectionCount("group-a", "same-member"), 3);
    assert.equal(await repository.getActiveDetectionCount("group-b", "same-member"), 1);
    assert.deepEqual((await repository.listActiveDetectionEvidence("group-a", "same-member")).map((event) => event.id),
        [first.id, second.id, third.id]);
    const detail = await repository.findGroupMember("group-a", "same-member");
    assert.equal(detail?.detectionMarks, 3,
        "member details read the active count directly without waiting for another message");
    assert.deepEqual(detail?.activeDetectionEvidence?.map((event) => event.id), [first.id, second.id, third.id],
        "member detail returns only current evidence with its type and individual expiration");

    setTime(OCTOBER_1 + MEMBER_BOT_DETECTION_EVIDENCE_TTL_MS);
    assert.equal(await repository.getActiveDetectionCount("group-a", "same-member"), 2,
        "the first event expires at its own expires_at boundary");
    assert.equal(await repository.getActiveDetectionCount("group-b", "same-member"), 1,
        "later evidence for the same member in another group has its own expiry");
    assert.deepEqual((await repository.listActiveDetectionEvidence("group-a", "same-member")).map((event) => event.id),
        [second.id, third.id]);
    assert.deepEqual((await repository.findGroupMember("group-a", "same-member"))?.activeDetectionEvidence?.map((event) => event.id),
        [second.id, third.id], "member detail immediately reflects one event crossing its expiry boundary");

    setTime(OCTOBER_1 + 9 * 24 * 60 * 60 * 1000);
    assert.equal(await repository.getActiveDetectionCount("group-a", "same-member"), 1,
        "one expired event does not clear later events");
    assert.deepEqual((await repository.findGroupMember("group-a", "same-member"))?.activeDetectionEvidence?.map((event) => event.id),
        [third.id]);
    setTime(OCTOBER_1 + 11 * 24 * 60 * 60 * 1000);
    assert.equal(await repository.getActiveDetectionCount("group-b", "same-member"), 0);
    const expiredDetail = await repository.findGroupMember("group-a", "same-member");
    assert.equal(expiredDetail?.detectionMarks, 0,
        "a read reports zero after seven quiet days even before pruning");
    assert.deepEqual(expiredDetail?.activeDetectionEvidence, [], "expired history is not returned as current evidence");
    await repository.pruneExpiredDetectionEvidence();
    assert.deepEqual(await repository.listActiveDetectionEvidence("group-a", "same-member"), []);

    setTime(OCTOBER_1 + 12 * 24 * 60 * 60 * 1000);
    await repository.addDetectionEvidence({ groupOpenid: "group-a", memberOpenid: "same-member", signalType: "manual-clear" });
    await repository.addDetectionEvidence({ groupOpenid: "group-a", memberOpenid: "another-member", signalType: "same-group-peer" });
    await repository.addDetectionEvidence({ groupOpenid: "group-b", memberOpenid: "same-member", signalType: "same-member-other-group" });
    const cleared = await repository.clearDetectionEvidence("group-a", "same-member");
    assert.equal(cleared.detectionMarks, 0);
    assert.equal(cleared.manualBot, true, "clearing evidence preserves the manual Bot identity");
    assert.equal(cleared.platformBot, true, "clearing evidence preserves the platform Bot identity");
    assert.equal(await repository.getActiveDetectionCount("group-a", "another-member"), 1,
        "clearing one member cannot delete evidence for another member in the same group");
    assert.equal(await repository.getActiveDetectionCount("group-b", "same-member"), 1,
        "clearing one group cannot delete evidence for that member in another group");
    assert.equal((await repository.getMemberBotState("group-b", "same-member")).platformBot, true,
        "clearing one group does not change another group");
}

async function verifyConservativeDetectionBehavior(
    repository: MemberRepository,
    setTime: (time: number) => void,
    getTime: () => number,
): Promise<void> {
    const group = "detector-backend-group";
    const memberId = "detector-backend-member";
    const text = "完全相同的长文本用于保守重复检测";
    await repository.upsertMember(member(group, memberId));
    const detector = new BotDetector(repository, getTime);
    const offsets = [0, 30_000, 60_000];
    const results = [];
    for (const [index, offset] of offsets.entries()) {
        setTime(OCTOBER_1 + offset);
        results.push(await detector.observe({ groupOpenid: group, memberOpenid: memberId, text,
            eligibleText: true, platformBot: false, messageId: `backend-${index}`, messageTimestamp: OCTOBER_1 + offset }));
    }
    assert.deepEqual(results.map((result) => result.markAdded), [false, false, true]);
    assert.equal(await repository.getActiveDetectionCount(group, memberId), 1);
    setTime(OCTOBER_1 + 61_000);
    assert.equal((await detector.observe({ groupOpenid: group, memberOpenid: memberId, text,
        eligibleText: true, platformBot: false, messageId: "backend-2", messageTimestamp: OCTOBER_1 + 60_000 })).markAdded, false,
    "a repeated QQ delivery remains deduplicated after the detector's event was written");

    const nextBatchAt = OCTOBER_1 + 60_000 + BOT_DETECTOR_SIGNAL_COOLDOWN_MS;
    for (const [index, offset] of [0, 30_000, 60_000].entries()) {
        setTime(nextBatchAt + offset);
        await detector.observe({ groupOpenid: group, memberOpenid: memberId, text,
            eligibleText: true, platformBot: false, messageId: `backend-next-${index}`, messageTimestamp: nextBatchAt + offset });
    }
    assert.equal(await repository.getActiveDetectionCount(group, memberId), 2,
        "the same behavior can create another observation only after its full cooldown");
    await repository.clearDetectionEvidence(group, memberId);
    assert.equal(await repository.getActiveDetectionCount(group, memberId), 0);
    assert.deepEqual(await repository.listRecentDetectionObservations(group, memberId, OCTOBER_1,
        nextBatchAt + BOT_DETECTOR_REPEAT_WINDOW_MS), [], "clear removes the scoring window too");
}

test("Memory, SQLite, and D1 share conservative deduplication, cooldown, and clear behavior", async () => {
    let time = OCTOBER_1;
    const memory = new MemoryMemberRepository(() => time);
    await verifyConservativeDetectionBehavior(memory, (next) => { time = next; }, () => time);

    const directory = await mkdtemp(join(tmpdir(), "tenbot-detector-backends-"));
    const sqlite = new SqliteMemberRepository(join(directory, "members.db"), () => time);
    const d1Database = new DatabaseSync(":memory:");
    await applySqlMigrations(d1Database, [1, 2, 4, 5, 6, 8, 7]);
    const d1 = new D1MemberRepository(d1Adapter(d1Database), () => time);
    try {
        time = OCTOBER_1;
        await verifyConservativeDetectionBehavior(sqlite, (next) => { time = next; }, () => time);
        time = OCTOBER_1;
        await verifyConservativeDetectionBehavior(d1, (next) => { time = next; }, () => time);
    } finally {
        sqlite.close();
        d1Database.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test("SQLite detector observations and evidence survive restart with the member and formal identity", async () => {
    let time = OCTOBER_1;
    const directory = await mkdtemp(join(tmpdir(), "tenbot-detector-restart-"));
    const path = join(directory, "members.db");
    let repository = new SqliteMemberRepository(path, () => time);
    try {
        await repository.upsertMember({ ...member("group-a", "member-a"), username: "Winter" });
        const text = "完全相同的长文本用于保守重复检测";
        const detector = new BotDetector(repository, () => time);
        for (let index = 0; index < 2; index++) {
            time = OCTOBER_1 + index * 30_000;
            await detector.observe({ groupOpenid: "group-a", memberOpenid: "member-a", text,
                eligibleText: true, platformBot: false, messageId: `restart-${index}`, messageTimestamp: time });
        }
        repository.close();
        time = OCTOBER_1 + 60_000;
        repository = new SqliteMemberRepository(path, () => time);
        const restartedDetector = new BotDetector(repository, () => time);
        const third = await restartedDetector.observe({ groupOpenid: "group-a", memberOpenid: "member-a", text,
            eligibleText: true, platformBot: false, messageId: "restart-2", messageTimestamp: time });
        assert.equal(third.markAdded, true, "the ten-minute observations can resume after process restart");
        await repository.setManualBot("group-a", "member-a", true, time);
        await repository.setPlatformBot("group-a", "member-a", true, time);
        repository.close();
        repository = new SqliteMemberRepository(path, () => time);
        const memberDetails = await repository.findGroupMember("group-a", "member-a");
        assert.equal(memberDetails?.username, "Winter");
        assert.equal(memberDetails?.manualBot, true);
        assert.equal(memberDetails?.platformBot, true);
        assert.equal(memberDetails?.detectionMarks, 1);
        assert.equal(memberDetails?.activeDetectionEvidence?.[0]?.signalType, "repeated_text");
    } finally {
        repository.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test("Memory, SQLite, and D1 repositories share per-event expiry and clear behavior", async () => {
    let time = OCTOBER_1;
    const memory = new MemoryMemberRepository(() => time);
    await verifyEvidenceBehavior(memory, (next) => { time = next; });

    const directory = await mkdtemp(join(tmpdir(), "tenbot-evidence-backends-"));
    const sqlite = new SqliteMemberRepository(join(directory, "members.db"), () => time);
    const d1Database = new DatabaseSync(":memory:");
    await applySqlMigrations(d1Database, [1, 2, 4, 5, 6, 8, 7]);
    const d1 = new D1MemberRepository(d1Adapter(d1Database), () => time);
    try {
        time = OCTOBER_1;
        await verifyEvidenceBehavior(sqlite, (next) => { time = next; });
        time = OCTOBER_1;
        await verifyEvidenceBehavior(d1, (next) => { time = next; });
    } finally {
        sqlite.close();
        d1Database.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test("legacy detector flags migrate once without changing human, platform, or group member data", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tenbot-legacy-bot-reset-"));
    const path = join(directory, "members.db");
    const seeded = new DatabaseSync(path);
    try {
        await applySqlMigrations(seeded, [1, 2, 4, 5]);
        seeded.prepare(`INSERT INTO group_members VALUES (?, ?, ?, ?, ?, ?, ?)`).run("group-a", "member-a", "Original Name", "admin", 10, 20, 30);
        seeded.prepare(`INSERT INTO member_bot_state VALUES (?, ?, 1, 1, 1, 9, ?, ?, ?)`)
            .run("group-a", "member-a", OCTOBER_1, 10, 30);
    } finally { seeded.close(); }

    let repository: SqliteMemberRepository | undefined = new SqliteMemberRepository(path, () => OCTOBER_1 + 100);
    try {
        const migrated = await repository.getMemberBotState("group-a", "member-a");
        assert.equal(migrated.autoBot, false);
        assert.equal(migrated.detectionMarks, 0);
        assert.equal(migrated.lastDetectionAt, null);
        assert.equal(migrated.manualBot, true);
        assert.equal(migrated.platformBot, true);
        const initialInspection = new DatabaseSync(path);
        try {
            const legacy = initialInspection.prepare(`SELECT platform_bot, manual_bot, auto_bot, detection_marks, last_detection_at
                FROM member_bot_state WHERE group_openid = ? AND member_openid = ?`).get("group-a", "member-a") as Record<string, number | null>;
            assert.deepEqual({ ...legacy }, {
                platform_bot: 1, manual_bot: 1, auto_bot: 0, detection_marks: 0, last_detection_at: null,
            }, "the one-time migration clears stored heuristic state while preserving formal identities");
        } finally { initialInspection.close(); }
        assert.deepEqual(await repository.findByOpenid("group-a", "member-a"), {
            groupOpenid: "group-a", memberOpenid: "member-a", username: "Original Name", role: "admin",
            firstSeenAt: 10, lastSeenAt: 20, updatedAt: 30,
        });

        const evidence = await repository.addDetectionEvidence({
            groupOpenid: "group-a", memberOpenid: "member-a", signalType: "new-rule",
        });
        const raw = new DatabaseSync(path);
        raw.prepare(`UPDATE member_bot_state SET auto_bot = 1, detection_marks = 41, last_detection_at = ?
            WHERE group_openid = ? AND member_openid = ?`).run(OCTOBER_1 + 101, "group-a", "member-a");
        raw.close();
        repository.close();
        repository = new SqliteMemberRepository(path, () => OCTOBER_1 + 100);

        assert.deepEqual(await repository.listActiveDetectionEvidence("group-a", "member-a"), [evidence],
            "a restart keeps evidence written after the one-time cleanup");
        assert.equal((await repository.getMemberBotState("group-a", "member-a")).detectionMarks, 1);
        const inspection = new DatabaseSync(path);
        try {
            const legacy = inspection.prepare(`SELECT auto_bot, detection_marks, last_detection_at
                FROM member_bot_state WHERE group_openid = ? AND member_openid = ?`).get("group-a", "member-a") as {
                auto_bot: number; detection_marks: number; last_detection_at: number;
            };
            assert.deepEqual({ ...legacy }, { auto_bot: 1, detection_marks: 41, last_detection_at: OCTOBER_1 + 101 },
                "the migration does not run again on restart");
            assert.equal((inspection.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 7").get() as { count: number }).count, 1);
        } finally { inspection.close(); }
    } finally {
        repository?.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test("D1 legacy cleanup is guarded by its migration version marker", async () => {
    const database = new DatabaseSync(":memory:");
    try {
        await applySqlMigrations(database, [1, 2, 4, 5, 6, 8]);
        database.prepare(`INSERT INTO group_members VALUES (?, ?, ?, NULL, 1, 1, 1)`).run("group-a", "member-a", "Name");
        database.prepare(`INSERT INTO member_bot_state VALUES (?, ?, 1, 1, 1, 6, 1, 1, 1)`).run("group-a", "member-a");
        const resetMigration = await readFile(resolve(process.cwd(), "migrations", "0007_reset_legacy_bot_detection.sql"), "utf8");
        database.exec(resetMigration);
        let state = database.prepare(`SELECT platform_bot, manual_bot, auto_bot, detection_marks, last_detection_at
            FROM member_bot_state`).get() as Record<string, number | null>;
        assert.deepEqual({ ...state }, { platform_bot: 1, manual_bot: 1, auto_bot: 0, detection_marks: 0, last_detection_at: null });

        const repository = new D1MemberRepository(d1Adapter(database), () => OCTOBER_1);
        await repository.addDetectionEvidence({ groupOpenid: "group-a", memberOpenid: "member-a", signalType: "new" });
        database.exec(resetMigration);
        assert.equal(await repository.getActiveDetectionCount("group-a", "member-a"), 1,
            "rerunning the migration script cannot clear later evidence");
    } finally { database.close(); }
});
