import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BotDetector } from "../src/members/bot-detector.js";
import { MemoryMemberRepository } from "../src/members/memory-repository.js";
import { SqliteMemberRepository } from "../src/members/sqlite-repository.js";
import type { KnownMember, MemberRepository } from "../src/members/repository.js";

function member(groupOpenid: string, memberOpenid: string): KnownMember {
    return { groupOpenid, memberOpenid, username: memberOpenid, firstSeenAt: 1, lastSeenAt: 1, updatedAt: 1 };
}

async function fixture() {
    const repository = new MemoryMemberRepository();
    let time = 1_700_000_000_000;
    const detector = new BotDetector(repository, () => time);
    const add = async (group = "group-a", memberId = "member-a") => repository.upsertMember(member(group, memberId));
    const observe = (text: string, group = "group-a", memberId = "member-a", eligibleText = true, platformBot = false) =>
        detector.observe({ groupOpenid: group, memberOpenid: memberId, text, eligibleText, platformBot });
    return { repository, detector, add, observe, setTime: (next: number) => { time = next; }, get time() { return time; } };
}

test("detector counts trimmed Unicode code points, not UTF-16 code units", async () => {
    const f = await fixture();
    await f.add();
    await f.observe("😀".repeat(11));
    await f.setTime(f.time + 1_000);
    await f.observe("😀".repeat(11));
    assert.equal((await f.repository.getMemberBotState("group-a", "member-a")).detectionMarks, 0);

    await f.observe("😀".repeat(10));
    await f.setTime(f.time + 1_000);
    await f.observe("😀".repeat(10));
    assert.equal((await f.repository.getMemberBotState("group-a", "member-a")).detectionMarks, 1);
});

test("a single short message is only a baseline and a gap over three seconds is not a burst", async () => {
    const f = await fixture();
    await f.add();
    await f.observe("hello");
    assert.equal((await f.repository.getMemberBotState("group-a", "member-a")).detectionMarks, 0);
    await f.setTime(f.time + 3_001);
    await f.observe("again");
    assert.equal((await f.repository.getMemberBotState("group-a", "member-a")).detectionMarks, 0);
    await f.setTime(f.time + 3_001);
    await f.observe("third");
    await f.setTime(f.time + 3_000);
    await f.observe("fourth");
    assert.equal((await f.repository.getMemberBotState("group-a", "member-a")).detectionMarks, 1,
        "an interval exactly at the three-second limit is eligible");
});

test("non-text, attachment, mention, and system observations break a short-text burst", async () => {
    const f = await fixture();
    await f.add();
    await f.observe("x");
    await f.setTime(f.time + 1_000);
    await f.observe("<image>", "group-a", "member-a", false);
    await f.setTime(f.time + 1_000);
    await f.observe("x");
    assert.equal((await f.repository.getMemberBotState("group-a", "member-a")).detectionMarks, 0);
    await f.setTime(f.time + 1_000);
    await f.observe("x");
    assert.equal((await f.repository.getMemberBotState("group-a", "member-a")).detectionMarks, 1);
});

test("a rapid burst adds one mark and cooldown messages cannot inflate it", async () => {
    const f = await fixture();
    await f.add();
    await f.observe("hi");
    await f.setTime(f.time + 3_000);
    await f.observe("hi");
    for (let index = 0; index < 10; index++) {
        await f.setTime(f.time + 1_000);
        await f.observe("hi");
    }
    assert.equal((await f.repository.getMemberBotState("group-a", "member-a")).detectionMarks, 1);

    await f.setTime(f.time + 10_000);
    await f.observe("hi");
    assert.equal((await f.repository.getMemberBotState("group-a", "member-a")).detectionMarks, 1,
        "the first message after cooldown starts a fresh baseline");
    await f.setTime(f.time + 1_000);
    await f.observe("hi");
    assert.equal((await f.repository.getMemberBotState("group-a", "member-a")).detectionMarks, 2);
});

test("concurrent short messages in one burst still add only one mark", async () => {
    const f = await fixture();
    await f.add();
    await f.observe("x");
    f.setTime(f.time + 1_000);
    await Promise.all(Array.from({ length: 10 }, () => f.observe("x")));
    assert.equal((await f.repository.getMemberBotState("group-a", "member-a")).detectionMarks, 1);
});

test("fifth burst marks auto_bot; four bursts remain ordinary members", async () => {
    const f = await fixture();
    await f.add();
    await f.observe("x");
    for (let burst = 1; burst <= 5; burst++) {
        await f.setTime(f.time + (burst === 1 ? 1_000 : 20_001));
        await f.observe("x");
        await f.setTime(f.time + 1_000);
        const result = await f.observe("x");
        const state = await f.repository.getMemberBotState("group-a", "member-a");
        assert.equal(state.detectionMarks, burst);
        assert.equal(state.autoBot, burst >= 5);
        if (burst === 5) assert.equal(result.markAdded, true);
    }
    await f.setTime(f.time + 1_000);
    await f.observe("x");
    assert.equal((await f.repository.getMemberBotState("group-a", "member-a")).detectionMarks, 5,
        "auto_bot accounts stop accumulating detector marks");
});

test("platform bots and manual bots are skipped by automatic detection", async () => {
    const f = await fixture();
    await f.add("group-a", "platform");
    await f.add("group-a", "manual");
    await f.repository.setPlatformBot("group-a", "platform", true, f.time);
    await f.repository.setManualBot("group-a", "manual", true, f.time);
    for (const id of ["platform", "manual"]) {
        await f.observe("x", "group-a", id);
        await f.setTime(f.time + 1_000);
        await f.observe("x", "group-a", id);
        assert.equal((await f.repository.getMemberBotState("group-a", id)).detectionMarks, 0);
    }
});

test("detector burst windows are isolated by both group and member", async () => {
    const f = await fixture();
    await f.add("group-a", "member-a");
    await f.add("group-a", "member-b");
    await f.add("group-b", "member-a");
    await f.observe("x", "group-a", "member-a");
    await f.setTime(f.time + 1_000);
    await f.observe("x", "group-a", "member-b");
    await f.setTime(f.time + 1_000);
    await f.observe("x", "group-b", "member-a");
    await f.setTime(f.time + 1_000);
    await f.observe("x", "group-a", "member-a");
    assert.equal((await f.repository.getMemberBotState("group-a", "member-a")).detectionMarks, 1);
    assert.equal((await f.repository.getMemberBotState("group-a", "member-b")).detectionMarks, 0);
    assert.equal((await f.repository.getMemberBotState("group-b", "member-a")).detectionMarks, 0);
});

test("detector restart preserves durable marks while dropping its in-memory burst window", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tenbot-bot-detector-"));
    const databasePath = join(directory, "members.db");
    let repository: MemberRepository = new SqliteMemberRepository(databasePath);
    try {
        await repository.upsertMember(member("group-a", "member-a"));
        let time = 1_700_000_000_000;
        let detector = new BotDetector(repository, () => time);
        await detector.observe({ groupOpenid: "group-a", memberOpenid: "member-a", text: "x", eligibleText: true, platformBot: false });
        time += 1_000;
        await detector.observe({ groupOpenid: "group-a", memberOpenid: "member-a", text: "x", eligibleText: true, platformBot: false });
        (repository as SqliteMemberRepository).close();

        repository = new SqliteMemberRepository(databasePath);
        detector = new BotDetector(repository, () => time);
        assert.equal((await repository.getMemberBotState("group-a", "member-a")).detectionMarks, 1);
        time += 1_000;
        await detector.observe({ groupOpenid: "group-a", memberOpenid: "member-a", text: "x", eligibleText: true, platformBot: false });
        assert.equal((await repository.getMemberBotState("group-a", "member-a")).detectionMarks, 1,
            "the restarted detector starts with a new in-memory baseline");
    } finally {
        if (repository instanceof SqliteMemberRepository) repository.close();
        await rm(directory, { recursive: true, force: true });
    }
});
