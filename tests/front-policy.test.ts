import assert from "node:assert/strict";
import test from "node:test";
import { decideFrontPolicy } from "../src/front/front-policy.js";
import type { FrontSignals } from "../src/front/front-policy.js";

const none: FrontSignals = {
    isPrivateMessage: false,
    hardMention: false,
    nameMention: false,
    conversationActive: false,
    quotedBot: false,
};

test("legacy policy never asks a Judge and keeps deterministic group wake signals", () => {
    assert.deepEqual(decideFrontPolicy("legacy", none), { kind: "pass" });
    assert.deepEqual(decideFrontPolicy("legacy", { ...none, nameMention: true }), {
        kind: "admit", wakeLevel: "soft", reason: "name-soft", admission: "name-soft",
    });
    assert.deepEqual(decideFrontPolicy("legacy", { ...none, conversationActive: true }), {
        kind: "admit", wakeLevel: "soft", reason: "active-soft", admission: "active-soft",
    });
    assert.deepEqual(decideFrontPolicy("legacy", { ...none, quotedBot: true }), {
        kind: "admit", wakeLevel: "soft", reason: "quoted-bot", admission: "quoted-bot",
    });
    assert.deepEqual(decideFrontPolicy("legacy", { ...none, hardMention: true }), {
        kind: "admit", wakeLevel: "hard", reason: "hard-mention", admission: "hard-mention",
    });
});

test("judge policy admits only private and explicit hard messages locally", () => {
    assert.deepEqual(decideFrontPolicy("judge", none), { kind: "judge" });
    assert.deepEqual(decideFrontPolicy("judge", { ...none, nameMention: true }), { kind: "judge" });
    assert.deepEqual(decideFrontPolicy("judge", { ...none, conversationActive: true }), { kind: "judge" });
    assert.deepEqual(decideFrontPolicy("judge", { ...none, quotedBot: true }), { kind: "judge" });
    assert.deepEqual(decideFrontPolicy("judge", { ...none, hardMention: true, quotedBot: true }), {
        kind: "admit", wakeLevel: "hard", reason: "hard-mention", admission: "hard-mention",
    });
});

test("private messages are hard in both policies and override other soft signals", () => {
    for (const mode of ["legacy", "judge"] as const) {
        assert.deepEqual(decideFrontPolicy(mode, {
            ...none,
            isPrivateMessage: true,
            nameMention: true,
            conversationActive: true,
            quotedBot: true,
        }), {
            kind: "admit", wakeLevel: "hard", reason: "private-message", admission: "private-message",
        });
    }
});
