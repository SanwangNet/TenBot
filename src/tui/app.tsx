import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { RuntimeStatus } from "../control/runtime-status.js";
import { MAX_TUI_LOG_ENTRIES, type TenBotControl } from "../control/tenbot-control.js";
import type { LogEntry } from "../shared/logger.js";
import { handleTuiKey } from "./key-handler.js";

const MAX_VISIBLE_LOGS = 9;

function timeOf(timestamp: string): string {
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime()) ? "--:--:--" : date.toLocaleTimeString("en-GB", { hour12: false });
}

function StatusPanel({ status }: { status: RuntimeStatus }) {
    const connectionColor = status.qq === "connected" ? "green" : status.qq === "error" ? "red" : "yellow";
    return <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Text bold>TenBot</Text>
        <Box flexDirection="row" flexWrap="wrap">
            <Text>QQ </Text><Text color={connectionColor}>{status.qq}</Text>
            <Text>  Provider {status.provider.id}</Text>
            <Text>  Model {status.provider.model}</Text>
            <Text>  Web Search {status.provider.webSearch ? "Yes" : "No"}</Text>
            <Text>  Cycles {status.activeCycles} active</Text>
            <Text>  Contexts {status.contextConversations}</Text>
            <Text>  Memes {status.memes.count} loaded r{status.memes.revision} ({timeOf(status.memes.loadedAt)})</Text>
            <Text>  Prompt r{status.prompt.revision} ({timeOf(status.prompt.loadedAt)})</Text>
            {!status.provider.configured && <Text color="yellow">  Provider credentials missing</Text>}
            {status.shuttingDown && <Text color="yellow">  Shutting down</Text>}
        </Box>
    </Box>;
}

function LogPanel({ logs, offset }: { logs: readonly LogEntry[]; offset: number }) {
    const end = Math.max(0, logs.length - offset);
    const start = Math.max(0, end - MAX_VISIBLE_LOGS);
    const visible = logs.slice(start, end);
    return <Box flexDirection="column" borderStyle="round" paddingX={1} flexGrow={1}>
        <Text bold>Logs {offset > 0 ? `(older, ${offset} entries from end)` : "(latest)"}</Text>
        {visible.length === 0
            ? <Text dimColor>Waiting for Runtime logs...</Text>
            : visible.map((entry, index) => <Text key={`${entry.timestamp}-${start + index}`} wrap="truncate" color={entry.level === "error" ? "red" : undefined}>
                {timeOf(entry.timestamp)} {entry.text}
            </Text>)}
    </Box>;
}

export interface TenBotTuiProps {
    control: TenBotControl;
    onQuit(): void;
}

export function TenBotTui({ control, onQuit }: TenBotTuiProps) {
    const [status, setStatus] = useState(() => control.getStatus());
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [notice, setNotice] = useState("");
    const [offset, setOffset] = useState(0);
    const quitting = useRef(false);

    useEffect(() => {
        const unsubscribeStatus = control.subscribeStatus(setStatus);
        const unsubscribeLogs = control.subscribeLogs((entry) => {
            setLogs((current) => [...current, entry].slice(-MAX_TUI_LOG_ENTRIES));
            setOffset((current) => current > 0
                ? Math.min(current + 1, MAX_TUI_LOG_ENTRIES - MAX_VISIBLE_LOGS)
                : 0);
        });
        return () => {
            unsubscribeStatus();
            unsubscribeLogs();
        };
    }, [control]);

    useInput((input, key) => {
        if (key.pageUp) {
            setOffset((current) => Math.min(logs.length, current + MAX_VISIBLE_LOGS));
            return;
        }
        if (key.pageDown) {
            setOffset((current) => Math.max(0, current - MAX_VISIBLE_LOGS));
            return;
        }
        if (key.end) {
            setOffset(0);
            return;
        }
        if ((input === "q" || (key.ctrl && input.toLowerCase() === "c")) && quitting.current) return;
        if (input === "q" || (key.ctrl && input.toLowerCase() === "c")) quitting.current = true;
        void handleTuiKey(input, key, control, setNotice, onQuit);
    });

    return <Box flexDirection="column" paddingX={1}>
        <StatusPanel status={status} />
        <LogPanel logs={logs} offset={offset} />
        <Box flexDirection="column" paddingX={1}>
            <Text dimColor>p Prompt  m Memes  r Reload  q Quit  ^C Quit  PgUp/PgDn  End</Text>
            {notice ? <Text color={notice.toLowerCase().includes("fail") ? "yellow" : "green"}>{notice}</Text> : null}
        </Box>
    </Box>;
}

export function StartupFailure({ message }: { message: string }) {
    return <Box flexDirection="column" paddingX={1}>
        <Text bold color="red">TenBot startup failed</Text>
        <Text>{message}</Text>
        <Text dimColor>Press q or Ctrl+C to exit.</Text>
    </Box>;
}
