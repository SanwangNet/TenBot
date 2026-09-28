import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { LogBuffer } from "../src/control/log-buffer.js";
import { logger, qqSdkLogger, parseLogLevel, debugPeerIdentity, refreshLogRedactionSecrets, setConsoleLogOutputEnabled, configureLogFileSink, flushLogFileSink, closeLogFileSink, sanitizeSafeDiagnostic, sanitizeSecrets } from "../src/shared/logger.js";
import { LogFileSink } from "../src/shared/log-file-sink.js";
import { collapseAdjacentLogs } from "../src/tui/log-collapse.js";
import { filterLogs, initialLogViewState, LogBatchQueue, logViewReducer, MAX_WEB_LOG_ENTRIES, LOG_LEVEL_FILTER_STORAGE_KEY, readStoredLogLevelFilter, storeLogLevelFilter } from "../web/src/components/log-state.js";
import type { LogEntry } from "../web/src/api/types.js";

function freshWebState() {
    return { ...initialLogViewState, entries: [] as LogEntry[] };
}

function localDay(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

async function runLoggerProcess(level?: string): Promise<{ directory: string; result: { entries: Array<{ level: string; text: string }>; outputs: Array<[string, string]>; allFile: string } }> {
    const directory = await mkdtemp(join(tmpdir(), "tenbot-console-level-"));
    const env: NodeJS.ProcessEnv = { ...process.env, TEST_LOG_DIR: directory, QQBOT_APP_SECRET: "TOP_SECRET_CHILD" };
    if (level === undefined) delete env.BOT_LOG_LEVEL;
    else env.BOT_LOG_LEVEL = level;
    const loggerUrl = new URL("../src/shared/logger.ts", import.meta.url).href;
    const script = `
const outputs = [];
for (const method of ["log", "warn", "error"]) console[method] = (...values) => outputs.push([method, values.map(String).join(" ")]);
const { logger, qqSdkLogger, debugPeerIdentity, subscribeLogs, configureLogFileSink, closeLogFileSink } = await import(${JSON.stringify(loggerUrl)});
const entries = [];
subscribeLogs((entry) => entries.push(entry));
configureLogFileSink(process.env.TEST_LOG_DIR);
logger.all("all raw", { member_openid: "visible-member", api_key: process.env.QQBOT_APP_SECRET });
logger.debug("debug marker");
logger.info("info marker");
logger.warn("warn marker");
logger.error("error marker");
qqSdkLogger.info("sdk info raw");
qqSdkLogger.debug("sdk debug raw");
qqSdkLogger.warn("sdk warn marker");
qqSdkLogger.error("sdk error marker");
debugPeerIdentity("peer", "peer-open-id");
await closeLogFileSink();
const fs = await import("node:fs/promises");
const path = await import("node:path");
const files = await fs.readdir(process.env.TEST_LOG_DIR);
const allFileName = files.find((name) => name.endsWith(".all.log"));
const allFile = await fs.readFile(path.join(process.env.TEST_LOG_DIR, allFileName), "utf8");
process.stdout.write(JSON.stringify({ entries, outputs, allFile }));
`;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
        cwd: process.cwd(), env, encoding: "utf8",
    });
    assert.equal(child.status, 0, String(child.stderr || child.error?.message || "Logger child process failed"));
    return { directory, result: JSON.parse(child.stdout) as { entries: Array<{ level: string; text: string }>; outputs: Array<[string, string]>; allFile: string } };
}

test("BOT_LOG_LEVEL only filters Console while every entry reaches listeners and file sink", async () => {
    assert.deepEqual(["all", "debug", "info", "warn", "error"].map((level) => parseLogLevel(level)), ["all", "debug", "info", "warn", "error"]);
    assert.equal(parseLogLevel(" DEBUG "), "debug");
    assert.equal(parseLogLevel(undefined), "info");
    assert.equal(parseLogLevel("invalid"), "info");
    const thresholds: Array<[string | undefined, string[]]> = [
        [undefined, ["info marker", "warn marker", "error marker", "sdk warn marker", "sdk error marker"]],
        ["all", ["all raw", "debug marker", "info marker", "warn marker", "error marker", "sdk info raw", "sdk debug raw", "sdk warn marker", "sdk error marker", "peer-open-id"]],
        ["debug", ["debug marker", "info marker", "warn marker", "error marker", "sdk warn marker", "sdk error marker"]],
        ["info", ["info marker", "warn marker", "error marker", "sdk warn marker", "sdk error marker"]],
        ["warn", ["warn marker", "error marker", "sdk warn marker", "sdk error marker"]],
        ["error", ["error marker", "sdk error marker"]],
        [" DEBUG ", ["debug marker", "info marker", "warn marker", "error marker", "sdk warn marker", "sdk error marker"]],
    ];
    for (const [threshold, expectedConsole] of thresholds) {
        const { directory, result } = await runLoggerProcess(threshold);
        try {
            assert.deepEqual(result.entries.map((entry) => entry.level), ["all", "debug", "info", "warn", "error", "all", "all", "warn", "error", "all"]);
            const consoleText = result.outputs.map(([, text]) => text).join("\n");
            for (const marker of expectedConsole) assert.ok(consoleText.includes(marker), `${threshold ?? "default"} Console should include ${marker}`);
            for (const marker of ["all raw", "debug marker", "info marker", "warn marker", "error marker", "sdk info raw", "sdk debug raw", "sdk warn marker", "sdk error marker", "peer-open-id"]) {
                assert.ok(result.allFile.includes(marker), `file sink should include ${marker} at ${threshold ?? "default"}`);
                assert.ok(result.entries.some((entry) => entry.text.includes(marker)), `listener should include ${marker} at ${threshold ?? "default"}`);
            }
            assert.doesNotMatch(consoleText + result.allFile + JSON.stringify(result.entries), /TOP_SECRET_CHILD/);
            const sdkAll = result.entries.filter((entry) => entry.level === "all" && /sdk (?:info|debug) raw/.test(entry.text));
            assert.equal(sdkAll.length, 2, "SDK raw info/debug are each written once as ALL");
            assert.equal(result.outputs.filter(([, text]) => text.includes("sdk debug raw")).length, threshold === "all" ? 1 : 0);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    }
    const invalid = await runLoggerProcess("TOP_SECRET_CHILD");
    try {
        assert.ok(invalid.result.outputs.some(([, text]) => text.includes("invalid BOT_LOG_LEVEL") && text.includes("falling back to info")));
        assert.doesNotMatch(invalid.result.outputs.map(([, text]) => text).join("\n"), /TOP_SECRET_CHILD/);
        assert.ok(invalid.result.outputs.some(([, text]) => text.includes("info marker")));
        assert.ok(!invalid.result.outputs.some(([, text]) => text.includes("debug marker")));
    } finally {
        await rm(invalid.directory, { recursive: true, force: true });
    }
});

test("legacy local Web log filter persists independently with info as its default", () => {
    const values = new Map<string, string>();
    const storage = {
        getItem(key: string) { return values.get(key) ?? null; },
        setItem(key: string, value: string) { values.set(key, value); },
    };
    assert.equal(LOG_LEVEL_FILTER_STORAGE_KEY, "tenbot.logs.level-filter");
    assert.equal(readStoredLogLevelFilter(storage), "info");
    storeLogLevelFilter("all-level", storage);
    assert.equal(values.get("tenbot.logs.level-filter"), "all-level");
    assert.equal(readStoredLogLevelFilter(storage), "all-level");
    values.set(LOG_LEVEL_FILTER_STORAGE_KEY, "invalid");
    assert.equal(readStoredLogLevelFilter(storage), "info");
});

test("ALL messages preserve raw business context for Web listeners independently of Console filtering", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tenbot-level-listener-"));
    const buffer = new LogBuffer();
    setConsoleLogOutputEnabled(false);
    configureLogFileSink(directory);
    try {
        logger.all("listener raw OpenID", { member_openid: "member-visible" });
        logger.debug("listener debug");
        logger.info("listener info");
        logger.warn("listener warn");
        logger.error("listener error");
        await flushLogFileSink();
        const rows = buffer.getEntries().map((entry) => entry.text).join("\n");
        assert.match(rows, /member-visible/);
        for (const marker of ["listener debug", "listener info", "listener warn", "listener error"]) assert.match(rows, new RegExp(marker));
        const date = `tenbot-${localDay(new Date())}`;
        const all = await readFile(join(directory, `${date}.all.log`), "utf8");
        for (const marker of ["listener raw OpenID", "listener debug", "listener info", "listener warn", "listener error"]) assert.match(all, new RegExp(marker));
    } finally {
        buffer.dispose();
        await closeLogFileSink();
        setConsoleLogOutputEnabled(true);
        await rm(directory, { recursive: true, force: true });
    }
});

test("10,000 identical logger events occupy one UI row while all.log keeps every event", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tenbot-repeat-files-"));
    const buffer = new LogBuffer();
    setConsoleLogOutputEnabled(false);
    configureLogFileSink(directory);
    try {
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
        setConsoleLogOutputEnabled(true);
        await rm(directory, { recursive: true, force: true });
    }
});

test("QQ SDK raw diagnostics are captured once as ALL in UI and all.log", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tenbot-qq-sdk-"));
    const buffer = new LogBuffer();
    setConsoleLogOutputEnabled(false);
    configureLogFileSink(directory);
    try {
        qqSdkLogger.debug?.("[qqbot:api] >>> POST https://api.example/messages");
        qqSdkLogger.debug?.('[qqbot:api] Body: {"content":"private message body"}');
        assert.equal(buffer.getEntries().filter((entry) => entry.level === "all" && entry.text.includes("private message body")).length, 1);
        assert.equal(buffer.getEntries().filter((entry) => entry.level === "all" && entry.text.includes("POST https://api.example/messages")).length, 1);
        await flushLogFileSink();
        const allFile = await readFile(join(directory, `tenbot-${localDay(new Date())}.all.log`), "utf8");
        assert.match(allFile, /private message body/);
        assert.match(allFile, /POST https:\/\/api\.example\/messages/);

        qqSdkLogger.debug?.('[qqbot:api] Body: {"content":"private message body"}');
        const bodyRow = buffer.getEntries().find((entry) => entry.level === "all" && entry.text.includes("private message body"));
        assert.equal(bodyRow?.repeatCount, 2);
        qqSdkLogger.warn?.("SDK warning", { details: "rate limit notice" });
        assert.ok(buffer.getEntries().some((entry) => entry.level === "warn" && entry.text.includes("rate limit notice")));
    } finally {
        buffer.dispose();
        await closeLogFileSink();
        setConsoleLogOutputEnabled(true);
        await rm(directory, { recursive: true, force: true });
    }
});

test("LogBuffer only folds adjacent rows with matching levels and exact text", () => {
    const buffer = new LogBuffer(20);
    setConsoleLogOutputEnabled(false);
    try {
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
        setConsoleLogOutputEnabled(true);
    }
});

test("LogBuffer capacity counts folded rows, retains the newest 5,000, and repeats do not evict history", () => {
    const buffer = new LogBuffer();
    setConsoleLogOutputEnabled(false);
    try {
        for (let index = 0; index < 10_000; index++) logger.all("one repeated row");
        for (let index = 0; index < 5_001; index++) logger.all(`unique ${index}`);
        const rows = buffer.getEntries();
        assert.equal(rows.length, 5_000);
        assert.equal(rows[0]?.text, "unique 1");
        assert.equal(rows.at(-1)?.text, "unique 5000");
    } finally {
        buffer.dispose();
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

test("Web log batch append preserves order, rowId repeats, follow counts, and trims once to 5,000", () => {
    const first: LogEntry = { timestamp: "1", level: "info", text: "same", rowId: "same-row", repeatCount: 1 };
    let state = { ...freshWebState(), follow: false };
    state = logViewReducer(state, { type: "append-batch", entries: [
        first,
        { ...first, timestamp: "3", repeatCount: 2 },
        { timestamp: "2", level: "info", text: "middle", rowId: "middle-row", repeatCount: 1 },
    ] });
    assert.deepEqual(state.entries.map((entry) => entry.text), ["same", "middle"]);
    assert.equal(state.entries[0]?.repeatCount, 2);
    assert.equal(state.entries[0]?.timestamp, "3");
    assert.equal(state.unseenCount, 2);
    assert.equal(state.rowsRevision, 1);

    const stressEntries = Array.from({ length: 10_000 }, (_, index): LogEntry => ({
        timestamp: String(index), level: "debug", text: `batch ${index}`, rowId: `batch-${index}`, repeatCount: 1,
    }));
    let stressState = { ...freshWebState(), follow: false };
    stressState = logViewReducer(stressState, { type: "append-batch", entries: stressEntries.slice(0, MAX_WEB_LOG_ENTRIES) });
    assert.equal(stressState.entries.length, MAX_WEB_LOG_ENTRIES);
    assert.equal(stressState.entries[0]?.text, "batch 0");
    stressState = logViewReducer(stressState, { type: "append-batch", entries: stressEntries.slice(MAX_WEB_LOG_ENTRIES) });
    assert.equal(stressState.entries.length, MAX_WEB_LOG_ENTRIES);
    assert.equal(stressState.entries[0]?.text, "batch 5000");
    assert.equal(stressState.entries.at(-1)?.text, "batch 9999");
    assert.equal(stressState.unseenCount, 10_000);
    assert.equal(state.unseenCount, 2);
});

test("log batch queue flushes a burst once and clear cancels stale pending logs", () => {
    const scheduled = new Map<number, () => void>();
    let nextHandle = 0;
    let state = freshWebState();
    let flushes = 0;
    const queue = new LogBatchQueue((entries) => {
        flushes++;
        state = logViewReducer(state, { type: "append-batch", entries });
    }, 30, (callback) => {
        const handle = ++nextHandle;
        scheduled.set(handle, callback);
        return handle;
    }, () => undefined);

    for (let index = 0; index < 10_000; index++) {
        queue.enqueue({ timestamp: String(index), level: "info", text: `queued ${index}`, rowId: `queued-${index}`, repeatCount: 1 });
    }
    assert.equal(scheduled.size, 1, "one timer is scheduled for the whole burst");
    scheduled.get(1)!();
    assert.equal(flushes, 1);
    assert.equal(state.entries.length, MAX_WEB_LOG_ENTRIES);
    assert.equal(state.entries[0]?.text, "queued 5000");
    assert.equal(state.entries.at(-1)?.text, "queued 9999");

    queue.enqueue({ timestamp: "stale", level: "error", text: "must not return after clear", rowId: "stale", repeatCount: 1 });
    const staleCallback = scheduled.get(2)!;
    queue.clear();
    state = logViewReducer(state, { type: "clear" });
    staleCallback();
    assert.equal(state.entries.length, 0);
    assert.equal(flushes, 1);

    queue.enqueue({ timestamp: "after-clear", level: "info", text: "new log", rowId: "new", repeatCount: 1 });
    scheduled.get(3)!();
    assert.deepEqual(state.entries.map((entry) => entry.text), ["new log"]);
    assert.equal(flushes, 2);

    queue.enqueue({ timestamp: "before-pause", level: "info", text: "arrived while following", rowId: "before-pause", repeatCount: 1 });
    queue.flushNow();
    state = logViewReducer(state, { type: "set-follow", follow: false });
    queue.enqueue({ timestamp: "paused", level: "info", text: "arrived while paused", rowId: "paused", repeatCount: 1 });
    scheduled.get(5)!();
    assert.equal(state.unseenCount, 1);
    queue.dispose();
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

test("ALL mode preserves business IDs but redacts credentials in listeners and disk", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tenbot-redaction-"));
    const oldSecret = process.env.QQBOT_APP_SECRET;
    const buffer = new LogBuffer();
    process.env.QQBOT_APP_SECRET = "TOP_SECRET_DIAGNOSTIC";
    refreshLogRedactionSecrets();
    configureLogFileSink(directory);
    try {
        setConsoleLogOutputEnabled(false);
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
        const filename = `tenbot-${localDay(new Date())}`;
        const allDisk = await readFile(join(directory, `${filename}.all.log`), "utf8");
        const infoDisk = await readFile(join(directory, `${filename}.info.log`), "utf8");
        const warnDisk = await readFile(join(directory, `${filename}.warn.log`), "utf8");
        for (const output of [bufferText, allDisk, infoDisk, warnDisk]) {
            assert.doesNotMatch(output, /TOP_SECRET_DIAGNOSTIC|SIGNED_VALUE|SIGNED_EXPIRY/);
        }
        for (const output of [bufferText, allDisk]) {
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
        if (oldSecret === undefined) delete process.env.QQBOT_APP_SECRET;
        else process.env.QQBOT_APP_SECRET = oldSecret;
        refreshLogRedactionSecrets();
        await rm(directory, { recursive: true, force: true });
    }
});
