import React from "react";
import { Box, Text } from "ink";
import type { LogEntry } from "../../shared/logger.js";
import { formatTime } from "../i18n.js";
import { Panel } from "../components/panel.js";
import { collapseAdjacentLogs } from "../log-collapse.js";

export function LogsView({ logs, offset, visibleLines }: { logs: readonly LogEntry[]; offset: number; visibleLines: number }) {
    const rows = collapseAdjacentLogs(logs);
    const end = Math.max(0, rows.length - offset);
    const start = Math.max(0, end - visibleLines);
    const visible = rows.slice(start, end);
    return <Panel title={`日志 · 最近 ${logs.length} 条`} flexGrow={1}>
        {visible.length === 0
            ? <Text dimColor>正在等待 Runtime 日志……</Text>
            : visible.map((row, index) => <Text key={`${row.entry.timestamp}-${start + index}`} wrap="truncate" color={row.entry.level === "error" ? "red" : undefined}>
                {formatTime(row.entry.timestamp)} {row.displayText}{row.count > 1 ? ` (x ${row.count})` : ""}
            </Text>)}
        {rows.length > visibleLines ? <Text dimColor>位置：{start + 1}-{end} / {rows.length}</Text> : null}
    </Panel>;
}
