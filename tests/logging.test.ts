import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LogBuffer } from "../src/control/log-buffer.js";
import { logger, qqSdkLogger, debugPeerIdentity, refreshLogSecrets, setConsoleLogOutputEnabled, configureLogFileSink, flushLogFileSink, closeLogFileSink, sanitizeSafeDiagnostic, sanitizeSecrets } from "../src/shared/logger.js";
import { LogFileSink } from "../src/shared/log-file-sink.js";
import { collapseAdjacentLogs } from "../src/tui/log-collapse.js";
import { filterLogs, initialLogViewState, LogBatchQueue, logViewReducer, MAX_WEB_LOG_ENTRIES } from "../web/src/components/log-state.js";
import type { LogEntry } from "../web/src/api/types.js";

function freshWebState() {
    return { ...initialLogViewState, entries: [] as LogEntry[] };
}

function localDay(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

test("all logger levels reach listeners while the three disk files retain their fixed ranges", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tenbot-levels-"));
    const oldSecret = process.env.QQBOT_APP_SECRET;
    const buffer = new LogBuffer();
    setConsoleLogOutputEnabled(false);
    configureLogFileSink(directory);
    try {
        process.env.QQBOT_APP_SECRET = "UNLABELLED_ENV_SECRET";
        refreshLogSecrets();
        logger.all("level-all", { member_openid: "member-openid-visible", api_key: "UNLABELLED_ENV_SECRET" });
        logger.all("unlabelled environment secret", "opaque value UNLABELLED_ENV_SECRET");
        logger.debug("level-debug", { member_openid: "debug-member-id" });
        logger.info("level-info");
        logger.warn("level-warn");
        logger.error("level-error");
        await closeLogFileSink();

        const date = `tenbot-${localDay(new Date())}`;
        const all = await readFile(join(directory, `${date}.all.log`), "utf8");
        const info = await readFile(join(directory, `${date}.info.log`), "utf8");
        const warn = await readFile(join(directory, `${date}.warn.log`), "utf8");
        for (const marker of ["level-all", "level-debug", "level-info", "level-warn", "level-error"]) assert.match(all, new RegExp(marker));
        assert.doesNotMatch(all, /UNLABELLED_ENV_SECRET/);
        assert.match(all, /member-openid-visible/);
        for (const marker of ["level-all", "level-debug"]) assert.doesNotMatch(info, new RegExp(marker));
        for (const marker of ["level-info", "level-warn", "level-error"]) assert.match(info, new RegExp(marker));
        for (const marker of ["level-all", "level-debug", "level-info"]) assert.doesNotMatch(warn, new RegExp(marker));
        for (const marker of ["level-warn", "level-error"]) assert.match(warn, new RegExp(marker));
        const uiMarkers = buffer.getEntries().map((entry) => entry.text);
        for (const marker of ["level-all", "level-debug", "level-info", "level-warn", "level-error"]) {
            assert.ok(uiMarkers.some((text) => text.includes(marker)), `UI should include ${marker}`);
        }
    } finally {
        buffer.dispose();
        await closeLogFileSink();
        setConsoleLogOutputEnabled(true);
        if (oldSecret === undefined) delete process.env.QQBOT_APP_SECRET;
        else process.env.QQBOT_APP_SECRET = oldSecret;
        refreshLogSecrets();
        await rm(directory, { recursive: true, force: true });
    }
});

test("all generated levels reach Console regardless of a legacy BOT_LOG_LEVEL value", () => {
    const oldLevel = process.env.BOT_LOG_LEVEL;
    const oldLog = console.log;
    const oldWarn = console.warn;
    const oldError = console.error;
    const output: string[] = [];
    process.env.BOT_LOG_LEVEL = "error";
    console.log = (...values: unknown[]) => output.push(values.map(String).join(" "));
    console.warn = (...values: unknown[]) => output.push(values.map(String).join(" "));
    console.error = (...values: unknown[]) => output.push(values.map(String).join(" "));
    setConsoleLogOutputEnabled(true);
    try {
        logger.all("console-all");
        logger.debug("console-debug");
        logger.info("console-info");
        logger.warn("console-warn");
        logger.error("console-error");
        for (const marker of ["console-all", "console-debug", "console-info", "console-warn", "console-error"]) {
            assert.ok(output.some((line) => line.includes(marker)), `Console should include ${marker}`);
        }
    } finally {
        console.log = oldLog;
        console.warn = oldWarn;
        console.error = oldError;
        if (oldLevel === undefined) delete process.env.BOT_LOG_LEVEL;
        else process.env.BOT_LOG_LEVEL = oldLevel;
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

test("QQ SDK info/debug each emit one complete diagnostic while warnings and errors keep their levels", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tenbot-qq-sdk-"));
    const buffer = new LogBuffer();
    setConsoleLogOutputEnabled(false);
    configureLogFileSink(directory);
    try {
        qqSdkLogger.debug?.("[qqbot:api] >>> POST https://api.example/messages");
        qqSdkLogger.debug?.('[qqbot:api] Body: {"content":"private message body"}');
        qqSdkLogger.info?.("connected");
        qqSdkLogger.warn?.("SDK warning", { details: "rate limit notice" });
        qqSdkLogger.error?.("SDK error", { details: "connection lost" });
        assert.equal(buffer.getEntries().filter((entry) => entry.level === "all" && entry.text.includes("POST https://api.example/messages")).length, 1);
        assert.equal(buffer.getEntries().filter((entry) => entry.level === "debug" && entry.text.includes("[QQ SDK] API POST")).length, 0);
        assert.equal(buffer.getEntries().filter((entry) => entry.level === "all" && entry.text.includes("private message body")).length, 1);
        assert.equal(buffer.getEntries().filter((entry) => entry.level === "all" && entry.text.includes("connected")).length, 1);
        assert.ok(buffer.getEntries().some((entry) => entry.level === "warn" && entry.text.includes("rate limit notice")));
        assert.ok(buffer.getEntries().some((entry) => entry.level === "error" && entry.text.includes("connection lost")));
        await flushLogFileSink();
        const allFile = await readFile(join(directory, `tenbot-${localDay(new Date())}.all.log`), "utf8");
        assert.match(allFile, /private message body/);
        assert.match(allFile, /POST https:\/\/api\.example\/messages/);

        assert.equal(buffer.getEntries().filter((entry) => entry.level === "all" && entry.text.includes("private message body")).length, 1);
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

test("raw diagnostics preserve business IDs but redact credentials in console, buffer, and disk", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tenbot-redaction-"));
    const oldSecret = process.env.QQBOT_APP_SECRET;
    const oldConsoleLog = console.log;
    const oldConsoleError = console.error;
    const oldConsoleWarn = console.warn;
    const buffer = new LogBuffer();
    const consoleLines: string[] = [];
    process.env.QQBOT_APP_SECRET = "TOP_SECRET_DIAGNOSTIC";
    refreshLogSecrets();
    console.log = (...values: unknown[]) => { consoleLines.push(values.map(String).join(" ")); };
    console.error = (...values: unknown[]) => { consoleLines.push(values.map(String).join(" ")); };
    console.warn = (...values: unknown[]) => { consoleLines.push(values.map(String).join(" ")); };
    configureLogFileSink(directory);
    try {
        setConsoleLogOutputEnabled(true);
        logger.all("[diagnostic] payload", {
            member_openid: "member-openid-visible-123",
            group_openid: "group-openid-visible-456",
            Authorization: "Bearer TOP_SECRET_DIAGNOSTIC",
            api_key: "TOP_SECRET_DIAGNOSTIC",
            Cookie: "session=TOP_SECRET_DIAGNOSTIC",
            github_client_secret: "GITHUB_CLIENT_SECRET_VALUE",
            qqbot_app_secret: "QQ_APP_SECRET_VALUE",
            access_token: "ACCESS_TOKEN_VALUE",
            refresh_token: "REFRESH_TOKEN_VALUE",
            oauth_token: "OAUTH_TOKEN_VALUE",
            session_token: "SESSION_TOKEN_VALUE",
            password: "PASSWORD_VALUE",
            credential: "CREDENTIAL_VALUE",
            private_key: "PRIVATE_KEY_VALUE",
            signature: "SIGNATURE_VALUE",
            content: "visible conversation text",
            toolError: Object.assign(new Error("tool failed with useful detail"), { status: 503, authorization: "Bearer TOP_SECRET_DIAGNOSTIC" }),
        });
        logger.all("raw authorization", "Authorization: Bearer TOP_SECRET_DIAGNOSTIC");
        logger.all("raw API key", "api_key=TOP_SECRET_DIAGNOSTIC");
        logger.all("raw cookie", "Cookie: session=TOP_SECRET_DIAGNOSTIC");
        logger.all("raw session token", "session_token=SESSION_TOKEN_VALUE oauth_token=OAUTH_TOKEN_VALUE");
        logger.all("raw signature", "signature=SIGNATURE_VALUE");
        logger.all("raw signature header", "X-Signature: HEADER_SIGNATURE_VALUE");
        logger.all("raw PEM private key", "-----BEGIN PRIVATE KEY-----PRIVATE_PEM_VALUE-----END PRIVATE KEY-----");
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
            assert.doesNotMatch(output, /TOP_SECRET_DIAGNOSTIC|SIGNED_VALUE|SIGNED_EXPIRY|GITHUB_CLIENT_SECRET_VALUE|QQ_APP_SECRET_VALUE|ACCESS_TOKEN_VALUE|REFRESH_TOKEN_VALUE|OAUTH_TOKEN_VALUE|SESSION_TOKEN_VALUE|PASSWORD_VALUE|CREDENTIAL_VALUE|PRIVATE_KEY_VALUE|SIGNATURE_VALUE|HEADER_SIGNATURE_VALUE|PRIVATE_PEM_VALUE/);
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
        refreshLogSecrets();
        await rm(directory, { recursive: true, force: true });
    }
});

test("debugPeerIdentity always records validated stable IDs as raw diagnostics", () => {
    const buffer = new LogBuffer();
    const oldConsole = console.log;
    const oldBotLogLevel = process.env.BOT_LOG_LEVEL;
    setConsoleLogOutputEnabled(false);
    console.log = () => undefined;
    try {
        process.env.BOT_LOG_LEVEL = "error";
        debugPeerIdentity("member", "stable-openid-123456789");
        debugPeerIdentity("oversized", "x".repeat(257));
        const entries = buffer.getEntries().filter((entry) => entry.level === "all");
        assert.equal(entries.length, 2);
        assert.match(entries[0]!.text, /stable-openid-123456789/);
        assert.match(entries[1]!.text, /\[invalid-id\]/);
    } finally {
        buffer.dispose();
        console.log = oldConsole;
        setConsoleLogOutputEnabled(true);
        if (oldBotLogLevel === undefined) delete process.env.BOT_LOG_LEVEL;
        else process.env.BOT_LOG_LEVEL = oldBotLogLevel;
    }
});
