import assert from "node:assert/strict";
import test from "node:test";
import { followStateFromTimelineScroll, syncTimelineToBottom, type ConversationTimelineViewport, type ProgrammaticScrollTarget } from "../web/src/conversations/conversation-scroll.js";

function viewport(scrollHeight: number, clientHeight: number, scrollTop = 0): ConversationTimelineViewport {
    return { scrollHeight, clientHeight, scrollTop };
}

function target(): ProgrammaticScrollTarget {
    return { current: null };
}

test("following synchronizes a newly rendered timeline to the bottom", () => {
    const element = viewport(1_000, 300, 620);
    const programmaticTarget = target();
    syncTimelineToBottom(element, true, programmaticTarget);
    assert.equal(element.scrollTop, 700);
    assert.equal(programmaticTarget.current, 700);
});

test("a matching programmatic scroll event does not change follow state", () => {
    const element = viewport(1_000, 300, 700);
    const programmaticTarget = { current: 700 };
    let follow = true;
    const nextFollow = followStateFromTimelineScroll(element, programmaticTarget);
    if (nextFollow !== null) follow = nextFollow;
    assert.equal(follow, true);
    assert.equal(programmaticTarget.current, null);
});

test("a user scroll beyond the bottom threshold stops follow", () => {
    const element = viewport(1_000, 300, 600);
    assert.equal(followStateFromTimelineScroll(element, target()), false);
});

test("new timeline content does not move the viewport while follow is disabled", () => {
    const element = viewport(1_000, 300, 310);
    const programmaticTarget = target();
    syncTimelineToBottom(element, false, programmaticTarget);
    assert.equal(element.scrollTop, 310);
    assert.equal(programmaticTarget.current, null);
});

test("resume action immediately returns to bottom and keeps follow enabled", () => {
    const element = viewport(850, 250, 280);
    const programmaticTarget = target();
    let follow = false;
    follow = true;
    syncTimelineToBottom(element, follow, programmaticTarget);
    const nextFollow = followStateFromTimelineScroll(element, programmaticTarget);
    if (nextFollow !== null) follow = nextFollow;
    assert.equal(element.scrollTop, 600);
    assert.equal(follow, true);
});

test("manual scrolling back inside 40px resumes follow", () => {
    assert.equal(followStateFromTimelineScroll(viewport(1_000, 300, 661), target()), true);
    assert.equal(followStateFromTimelineScroll(viewport(1_000, 300, 660), target()), false);
});

test("switching to a loaded conversation resets follow and positions its timeline at bottom", () => {
    const otherConversation = viewport(1_400, 400, 0);
    const programmaticTarget = target();
    let follow = false;
    follow = true;
    syncTimelineToBottom(otherConversation, follow, programmaticTarget);
    assert.equal(otherConversation.scrollTop, 1_000);
});

test("an asynchronously loaded timeline is positioned at bottom on its first layout", () => {
    const loading = viewport(300, 300, 0);
    const programmaticTarget = target();
    syncTimelineToBottom(loading, true, programmaticTarget);
    const loaded = viewport(1_100, 300, loading.scrollTop);
    syncTimelineToBottom(loaded, true, programmaticTarget);
    assert.equal(loaded.scrollTop, 800);
});

test("same-length attempt status replacement still synchronizes while following", () => {
    const items = [{ id: "attempt-1", status: "generating" }];
    const updatedItems = [{ ...items[0]!, status: "completed" }];
    assert.equal(items.length, updatedItems.length);
    const element = viewport(1_200, 300, 400);
    const programmaticTarget = target();
    syncTimelineToBottom(element, true, programmaticTarget);
    assert.equal(element.scrollTop, 900);
});

test("same-length attempt updates never steal the viewport while not following", () => {
    const items = [{ id: "attempt-1", status: "generating" }];
    const updatedItems = [{ ...items[0]!, status: "completed" }];
    assert.equal(items.length, updatedItems.length);
    const element = viewport(1_200, 300, 400);
    syncTimelineToBottom(element, false, target());
    assert.equal(element.scrollTop, 400);
});
