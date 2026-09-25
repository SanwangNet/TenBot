import React from "react";
import { Box, Text } from "ink";
import type { LogEntry } from "../../shared/logger.js";
import { formatTime, formatTuiLogText } from "../i18n.js";
import { Panel } from "../components/panel.js";

export function LogsView({ logs, offset, visibleLines }: { logs: readonly LogEntry[]; offset: number; visibleLines: number }) {
    const end = Math.max(0, logs.length - offset);
    const start = Math.max(0, end - visibleLines);
    const visible = logs.slice(start, end);
    return <Panel title={`日志 · 最近 ${logs.length} 条`} flexGrow={1}>
        {visible.length === 0
            ? <Text dimColor>正在等待 Runtime 日志……</Text>
            : visible.map((entry, index) => <Text key={`${entry.timestamp}-${start + index}`} wrap="truncate" color={entry.level === "error" ? "red" : undefined}>
                {formatTime(entry.timestamp)} {formatTuiLogText(entry)}
            </Text>)}
        {logs.length > visibleLines ? <Text dimColor>位置：{start + 1}-{end} / {logs.length}</Text> : null}
    </Panel>;
}
