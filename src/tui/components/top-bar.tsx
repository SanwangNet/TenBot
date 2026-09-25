import React from "react";
import { Box, Text } from "ink";
import type { RuntimeStatus } from "../../control/runtime-status.js";
import { connectionColor, connectionLabel, formatTime, providerLabel } from "../i18n.js";

export function TopBar({ status, now, compact = false }: { status: RuntimeStatus; now: Date; compact?: boolean }) {
    const provider = `${providerLabel(status.provider.id)} / ${status.provider.model}`;
    return <Box borderStyle="single" borderBottom flexShrink={0} paddingX={1}>
        <Text bold>TenBot</Text>
        <Text> │ </Text>
        <Text color={connectionColor(status.qq)}>● QQ {connectionLabel(status.qq)}</Text>
        {!compact ? <>
            <Text> │ </Text>
            <Text color="cyan">◆ {provider}</Text>
            <Text> │ </Text>
            <Text>◉ {status.activeCycles} 个活动周期</Text>
        </> : null}
        <Box flexGrow={1} />
        <Text dimColor>{formatTime(now.toISOString())}</Text>
    </Box>;
}
