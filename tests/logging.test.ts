import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LogBuffer } from "../src/control/log-buffer.js";
import { logger, qqSdkLogger, getLogLevel, setConsoleLogOutputEnabled, setLogLevel, configureLogFileSink, flushLogFileSink, closeLogFileSink, sanitizeSafeDiagnostic, sanitizeSecrets } from "../src/shared/logger.js";
import { LogFileSink } from "../src/shared/log-file-sink.js";
import { collapseAdjacentLogs } from "../src/tui/log-collapse.js";
import { filterLogs, initialLogViewState, logViewReducer, MAX_WEB_LOG_ENTRIES } from "../web/src/components/log-state.js";
import type { LogEntry } from "../web/src/api/types.js";

function freshWebState() {
    return { ...initialLogViewState, entries: [] as LogEntry[] };
}

function localDay(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

test("log-level priority gates Console and UI while the three disk files retain their fixed ranges", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tenbot-levels-"));
    const oldLevel = getLogLevel();
    const buffer = new LogBuffer();
    setConsoleLogOutputEnabled(false);
    configureLogFileSink(directory);
    try {
        setLogLevel("all");
        logger.all("level-all");
        logger.debug("debug-under-all");
        logger.info("info-under-all");
        logger.warn("warn-under-all");
        logger.error("error-under-all");
        setLogLevel("debug");
        logger.all("drop-all-under-debug");
        logger.debug("debug-under-debug");
        logger.info("info-under-debug");
        logger.warn("warn-under-debug");
        logger.error("error-under-debug");
        setLogLevel("info");
        logger.all("file-all-under-info");
        logger.debug("drop-debug-under-info");
        logger.info("info-under-info");
        logger.warn("warn-under-info");
        logger.error("error-under-info");
        setLogLevel("warn");
        logger.all("file-all-under-warn");
        logger.debug("drop-debug-under-warn");
        logger.info("drop-info-under-warn");
        logger.warn("warn-under-warn");
        logger.error("error-under-warn");
        setLogLevel("error");
        logger.warn("drop-warn-under-error");
        logger.info("drop-info-under-error");
        logger.error("error-under-error");
        await closeLogFileSink();

        const date = `tenbot-${localDay(new Date())}`;
        const all = await readFile(join(directory, `${date}.all.log`), "utf8");
        const info = await readFile(join(directory, `${date}.info.log`), "utf8");
        const warn = await readFile(join(directory, `${date}.warn.log`), "utf8");
        for (const marker of ["level-all", "debug-under-all", "info-under-all", "warn-under-all", "error-under-all", "drop-all-under-debug", "debug-under-debug", "info-under-debug", "warn-under-debug", "error-under-debug", "file-all-under-info", "drop-debug-under-info", "info-under-info", "warn-under-info", "error-under-info", "file-all-under-warn", "drop-debug-under-warn", "drop-info-under-warn", "warn-under-warn", "error-under-warn", "drop-warn-under-error", "drop-info-under-error", "error-under-error"]) {
            assert.match(all, new RegExp(marker));
        }
        for (const marker of ["level-all", "debug-under-all", "drop-all-under-debug", "file-all-under-info", "drop-debug-under-info", "file-all-under-warn", "drop-debug-under-warn"]) {
            assert.doesNotMatch(info, new RegExp(marker));
        }
        for (const marker of ["info-under-all", "warn-under-all", "error-under-all", "info-under-debug", "warn-under-debug", "error-under-debug", "info-under-info", "warn-under-info", "error-under-info", "drop-info-under-warn", "drop-info-under-error", "drop-warn-under-error"]) {
            assert.match(info, new RegExp(marker));
        }
        for (const marker of ["level-all", "debug-under-all", "info-under-all", "info-under-info", "drop-info-under-warn", "drop-info-under-error"]) {
            assert.doesNotMatch(warn, new RegExp(marker));
        }
        for (const marker of ["warn-under-all", "error-under-all", "warn-under-debug", "error-under-debug", "warn-under-info", "error-under-info", "warn-under-warn", "error-under-warn", "drop-warn-under-error", "error-under-error"]) {
            assert.match(warn, new RegExp(marker));
        }
        const uiMarkers = buffer.getEntries().filter((entry) => /level-all|under-/.test(entry.text)).map((entry) => entry.text);
        for (const marker of ["level-all", "debug-under-all", "info-under-all", "warn-under-all", "error-under-all", "debug-under-debug", "info-under-debug", "warn-under-debug", "error-under-debug", "info-under-info", "warn-under-info", "error-under-info", "warn-under-warn", "error-under-warn", "error-under-error"]) {
            assert.ok(uiMarkers.some((text) => text.includes(marker)), `UI should include ${marker}`);
        }
        for (const marker of ["drop-all-under-debug", "drop-debug-under-info", "file-all-under-info", "file-all-under-warn", "drop-debug-under-warn", "drop-info-under-warn", "drop-warn-under-error", "drop-info-under-error"]) {
            assert.ok(!uiMarkers.some((text) => text.includes(marker)), `UI should omit ${marker}`);
        }
    } finally {
        buffer.dispose();
        await closeLogFileSink();
        setLogLevel(oldLevel);
        setConsoleLogOutputEnabled(true);
        await rm(directory, { recursive: true, force: true });
    }
});

test("10,000 identical logger events occupy one UI row while all.log keeps every event", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tenbot-repeat-files-"));
    const oldLevel = getLogLevel();
    const buffer = new LogBuffer();
    setConsoleLogOutputEnabled(false);
    configureLogFileSink(directory);
    try {
        setLogLevel("all");
        const live: LogEntry[] = [];
        const unsubscribe = buffer.subscribe((entry) => live.push(entry));
        for (let index = 0; index < 10_000; index++) logger.all("response.output_text.delta", { delta: "same" });
        const rows = buffer.getEntries().filter((entry) => entry.text.includes("response.output_text.delta"));
        assert.equal(rows.length, 1);
        assert.equal(rows[0]?.repeatCount, 10_000);
        assert.equal(rows[0]?.timestamp, live.at(-1)?.timestamp);
        const liveRepeated = live.filter((entry) => entry.text.includes("response.output_text.delta"));
        assert.equal(new Set(liveRepeated.map((entry) => entry.rowId)).size, 1);
        assert.equal(liveRepeated.at(-1)?.repeatCount, 10_000);
        assert.equal(collapseAdjacentLogs(rows)[0]?.count, 10_000);
        unsubscribe();
        await closeLogFileSink();
        const allLog = await readFile(join(directory, `tenbot-${localDay(new Date())}.all.log`), "utf8");
        assert.equal(allLog.split("\n").filter((line) => line.includes("response.output_text.delta")).length, 10_000);
    } finally {
        buffer.dispose();
        await closeLogFileSink();
        setLogLevel(oldLevel);
        setConsoleLogOutputEnabled(true);
        await rm(directory, { recursive: true, force: true });
    }
});

test("QQ SDK diagnostics stay summarized in UI while all.log always keeps exposed raw payloads", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tenbot-qq-sdk-"));
    const oldLevel = getLogLevel();
    const buffer = new LogBuffer();
    setConsoleLogOutputEnabled(false);
    configureLogFileSink(directory);
    try {
        setLogLevel("debug");
        qqSdkLogger.debug?.("[qqbot:api] >>> POST https://api.example/messages");
        qqSdkLogger.debug?.('[qqbot:api] Body: {"content":"private message body"}');
        assert.ok(buffer.getEntries().some((entry) => entry.text === "[QQ SDK] API POST"));
        assert.ok(!buffer.getEntries().some((entry) => entry.text.includes("private message body")));
        await flushLogFileSink();
        const allFile = await readFile(join(directory, `tenbot-${localDay(new Date())}.all.log`), "utf8");
        assert.match(allFile, /private message body/);
        assert.match(allFile, /POST https:\/\/api\.example\/messages/);

        setLogLevel("all");
        qqSdkLogger.debug?.('[qqbot:api] Body: {"content":"private message body"}');
        assert.ok(buffer.getEntries().some((entry) => entry.level === "all" && entry.text.includes("private message body")));
        setLogLevel("warn");
        qqSdkLogger.warn?.("SDK warning", { details: "rate limit notice" });
        assert.ok(buffer.getEntries().some((entry) => entry.level === "warn" && entry.text.includes("rate limit notice")));
    } finally {
        buffer.dispose();
        await closeLogFileSink();
        setLogLevel(oldLevel);
        setConsoleLogOutputEnabled(true);
        await rm(directory, { recursive: true, force: true });
    }
});

test("LogBuffer only folds adjacent rows with matching levels and exact text", () => {
    const oldLevel = getLogLevel();
    const buffer = new LogBuffer(20);
    setConsoleLogOutputEnabled(false);
    try {
        setLogLevel("all");
        logger.all("A");
        logger.all("A");
        logger.debug("A");
        logger.debug("B");
        logger.debug("A");
        logger.debug("C");
        logger.debug("C ");
        assert.deepEqual(buffer.getEntries().map(({ level, text, repeatCount }) => [level, text, repeatCount]), [
            ["all", "A", 2], ["debug", "A", 1], ["debug", "B", 1],
            ["debug", "A", 1], ["debug", "C", 1], ["debug", "C ", 1],
        ]);
    } finally {
        buffer.dispose();
        setLogLevel(oldLevel);
        setConsoleLogOutputEnabled(true);
    }
});

test("LogBuffer capacity counts folded rows, retains the newest 5,000, and repeats do not evict history", () => {
    const oldLevel = getLogLevel();
    const buffer = new LogBuffer();
    setConsoleLogOutputEnabled(false);
    try {
        setLogLevel("all");
        for (let index = 0; index < 10_000; index++) logger.all("one repeated row");
        for (let index = 0; index < 5_001; index++) logger.all(`unique ${index}`);
        const rows = buffer.getEntries();
        assert.equal(rows.length, 5_000);
        assert.equal(rows[0]?.text, "unique 1");
        assert.equal(rows.at(-1)?.text, "unique 5000");
    } finally {
        buffer.dispose();
        setLogLevel(oldLevel);
        setConsoleLogOutputEnabled(true);
    }
});

test("Web log reducer updates canonical rows, replaces reconnect snapshots, filters raw text, and clears locally", () => {
    const first: LogEntry = { timestamp: "t1", firstTimestamp: "t1", level: "all", text: "delta private text", rowId: "a", repeatCount: 1 };
    let state = logViewReducer(freshWebState(), { type: "append", entry: first });
    state = logViewReducer(state, { type: "append", entry: { ...first, timestamp: "t2", repeatCount: 2 } });
    assert.equal(state.entries.length, 1);
    assert.equal(state.entries[0]?.repeatCount, 2);
    assert.equal(state.entries[0]?.timestamp, "t2");

    const replay: LogEntry[] = [{ ...first, timestamp: "t10", repeatCount: 10 }];
    state = logViewReducer(state, { type: "snapshot", entries: replay });
    state = logViewReducer(state, { type: "snapshot", entries: replay });
    assert.equal(state.entries.length, 1);
    assert.equal(state.entries[0]?.repeatCount, 10);
    assert.equal(filterLogs(state.entries, "all", "private text")[0]?.repeatCount, 10);
    assert.deepEqual(filterLogs(state.entries, "debug", "private text"), []);
    assert.deepEqual(logViewReducer(state, { type: "clear" }).entries, []);
    assert.equal(state.entries[0]?.repeatCount, 10);
});

test("Web log reducer bounds storage to 5,000 canonical rows", () => {
    let state = freshWebState();
    for (let index = 0; index <= MAX_WEB_LOG_ENTRIES; index++) {
        state = logViewReducer(state, { type: "append", entry: { timestamp: String(index), level: "info", text: `line ${index}`, rowId: String(index), repeatCount: 1 } });
    }
    assert.equal(state.entries.length, 5_000);
    assert.equal(state.entries[0]?.text, "line 1");
    assert.equal(state.entries.at(-1)?.text, "line 5000");
});

test("daily file sink routes all/info/warn categories, appends across reopen, preserves order, and flushes", async () => {
    const parent = await mkdtemp(join(tmpdir(), "tenbot-logs-"));
    const directory = join(parent, "logs");
    const date = new Date(2026, 8, 27, 12, 0, 0);
    const dateKey = localDay(date);
    const timestamp = date.toISOString();
    try {
        const first = new LogFileSink(directory);
        first.write({ timestamp, level: "info", text: "first" });
        first.write({ timestamp, level: "all", text: "safe raw placeholder" }, "raw payload {\n  \"input\": \"kept\"\n}");
        first.write({ timestamp, level: "debug", text: "debug only all" });
        first.write({ timestamp, level: "warn", text: "warning" });
        first.write({ timestamp, level: "error", text: "failure" });
        await first.close();
        const restarted = new LogFileSink(directory);
        restarted.write({ timestamp, level: "debug", text: "after restart" });
        await restarted.close();
        const all = await readFile(join(directory, `tenbot-${dateKey}.all.log`), "utf8");
        const info = await readFile(join(directory, `tenbot-${dateKey}.info.log`), "utf8");
        const warn = await readFile(join(directory, `tenbot-${dateKey}.warn.log`), "utf8");
        assert.ok(all.indexOf("first") < all.indexOf("raw payload"));
        assert.ok(all.indexOf("raw payload") < all.indexOf("debug only all"));
        assert.ok(all.indexOf("debug only all") < all.indexOf("warning"));
        assert.ok(all.indexOf("warning") < all.indexOf("failure"));
        assert.ok(all.indexOf("failure") < all.indexOf("after restart"));
        assert.match(all, /ALL raw payload/);
        assert.doesNotMatch(info, /raw payload|debug only all|after restart/);
        assert.match(info, /INFO first/);
        assert.match(info, /WARN warning/);
        assert.match(info, /ERROR failure/);
        assert.match(warn, /WARN warning/);
        assert.match(warn, /ERROR failure/);
        assert.doesNotMatch(warn, /first|raw payload|debug only all/);
        assert.deepEqual((await readdir(directory)).sort(), [`tenbot-${dateKey}.all.log`, `tenbot-${dateKey}.info.log`, `tenbot-${dateKey}.warn.log`]);
    } finally {
        await rm(parent, { recursive: true, force: true });
    }
});

test("daily file sink rolls over at local midnight", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tenbot-rollover-"));
    const beforeMidnight = new Date(2026, 8, 27, 23, 59, 59, 900);
    const afterMidnight = new Date(2026, 8, 28, 0, 0, 0, 100);
    try {
        const sink = new LogFileSink(directory);
        sink.write({ timestamp: beforeMidnight.toISOString(), level: "info", text: "before midnight" });
        sink.write({ timestamp: afterMidnight.toISOString(), level: "info", text: "after midnight" });
        await sink.close();
        const files = (await readdir(directory)).sort();
        const before = `tenbot-${localDay(beforeMidnight)}`;
        const after = `tenbot-${localDay(afterMidnight)}`;
        assert.deepEqual(files, [`${before}.all.log`, `${before}.info.log`, `${after}.all.log`, `${after}.info.log`].sort());
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("file sink reports an unwritable directory once and does not throw into callers", async () => {
    const parent = await mkdtemp(join(tmpdir(), "tenbot-log-error-"));
    const notDirectory = join(parent, "file");
    await writeFile(notDirectory, "file blocks directory creation");
    let failures = 0;
    try {
        const sink = new LogFileSink(notDirectory, () => failures++);
        const entry = { timestamp: new Date().toISOString(), level: "info" as const, text: "safe" };
        sink.write(entry);
        sink.write(entry);
        await sink.close();
        assert.equal(failures, 1);
    } finally {
        await rm(parent, { recursive: true, force: true });
    }
});

test("ALL mode preserves business IDs but redacts credentials in console, buffer, and disk", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tenbot-redaction-"));
    const oldLevel = getLogLevel();
    const oldSecret = process.env.QQBOT_APP_SECRET;
    const oldConsoleLog = console.log;
    const oldConsoleError = console.error;
    const oldConsoleWarn = console.warn;
    const buffer = new LogBuffer();
    const consoleLines: string[] = [];
    process.env.QQBOT_APP_SECRET = "TOP_SECRET_DIAGNOSTIC";
    console.log = (...values: unknown[]) => { consoleLines.push(values.map(String).join(" ")); };
    console.error = (...values: unknown[]) => { consoleLines.push(values.map(String).join(" ")); };
    console.warn = (...values: unknown[]) => { consoleLines.push(values.map(String).join(" ")); };
    configureLogFileSink(directory);
    try {
        setConsoleLogOutputEnabled(true);
        setLogLevel("all");
        logger.all("[diagnostic] payload", {
            member_openid: "member-openid-visible-123",
            group_openid: "group-openid-visible-456",
            Authorization: "Bearer TOP_SECRET_DIAGNOSTIC",
            api_key: "TOP_SECRET_DIAGNOSTIC",
            Cookie: "session=TOP_SECRET_DIAGNOSTIC",
            content: "visible conversation text",
            toolError: Object.assign(new Error("tool failed with useful detail"), { status: 503, authorization: "Bearer TOP_SECRET_DIAGNOSTIC" }),
        });
        logger.all("raw authorization", "Authorization: Bearer TOP_SECRET_DIAGNOSTIC");
        logger.all("raw API key", "api_key=TOP_SECRET_DIAGNOSTIC");
        logger.all("raw cookie", "Cookie: session=TOP_SECRET_DIAGNOSTIC");
        logger.all("signed URL", "https://cdn.example/resource?hm=SIGNED_VALUE&ex=SIGNED_EXPIRY&plain=kept");
        logger.info("info credential copy", { content: "visible info", apiKey: "TOP_SECRET_DIAGNOSTIC", member_openid: "info-id-not-in-safe-files" });
        logger.warn("warn credential copy", { content: "visible warning", Authorization: "Bearer TOP_SECRET_DIAGNOSTIC", group_openid: "warn-id-not-in-safe-files" });
        logger.error("error credential copy", { content: "visible error", Cookie: "session=TOP_SECRET_DIAGNOSTIC" });
        await flushLogFileSink();
        const bufferText = buffer.getEntries().map((entry) => entry.text).join("\n");
        const consoleText = consoleLines.join("\n");
        const filename = `tenbot-${localDay(new Date())}`;
        const allDisk = await readFile(join(directory, `${filename}.all.log`), "utf8");
        const infoDisk = await readFile(join(directory, `${filename}.info.log`), "utf8");
        const warnDisk = await readFile(join(directory, `${filename}.warn.log`), "utf8");
        for (const output of [bufferText, consoleText, allDisk, infoDisk, warnDisk]) {
            assert.doesNotMatch(output, /TOP_SECRET_DIAGNOSTIC|SIGNED_VALUE|SIGNED_EXPIRY/);
        }
        for (const output of [bufferText, consoleText, allDisk]) {
            assert.match(output, /member-openid-visible-123/);
            assert.match(output, /group-openid-visible-456/);
            assert.match(output, /visible conversation text/);
            assert.match(output, /tool failed with useful detail/);
            assert.match(output, /503/);
        }
        assert.match(allDisk, /plain=kept/);
        assert.doesNotMatch(infoDisk, /member-openid-visible-123|info-id-not-in-safe-files|warn-id-not-in-safe-files/);
        assert.doesNotMatch(warnDisk, /member-openid-visible-123|info-id-not-in-safe-files|warn-id-not-in-safe-files/);
        assert.match(sanitizeSecrets("member_openid=member-openid-visible-123"), /member-openid-visible-123/);
        assert.match(sanitizeSafeDiagnostic("member_openid=member-openid-visible-123"), /\[ID\]/);
        assert.deepEqual((await readdir(directory)).sort(), [`${filename}.all.log`, `${filename}.info.log`, `${filename}.warn.log`]);
    } finally {
        buffer.dispose();
        await closeLogFileSink();
        setConsoleLogOutputEnabled(true);
        console.log = oldConsoleLog;
        console.error = oldConsoleError;
        console.warn = oldConsoleWarn;
        if (oldSecret === undefined) delete process.env.QQBOT_APP_SECRET;
        else process.env.QQBOT_APP_SECRET = oldSecret;
        setLogLevel(oldLevel);
        await rm(directory, { recursive: true, force: true });
    }
});
