import React from "react";
import { Box, Text } from "ink";
import type { AutomatedPeerSummary } from "../../control/automated-peers.js";
import { formatTime } from "../i18n.js";
import { ClickableRegion } from "../components/clickable-region.js";
import { Panel } from "../components/panel.js";
import type { ClickableRegionRegistry } from "../mouse-input.js";

export function AutomatedPeersView({
    registered,
    recent,
    selectedIndex,
    visibleCount,
    registry,
    onOpen,
}: {
    registered: readonly AutomatedPeerSummary[];
    recent: readonly AutomatedPeerSummary[];
    selectedIndex: number;
    visibleCount: number;
    registry: ClickableRegionRegistry;
    onOpen(index: number): void;
}) {
    const all = [
        ...registered.map((peer) => ({ peer, registered: true })),
        ...recent.map((peer) => ({ peer, registered: false })),
    ];
    const count = Math.max(1, visibleCount);
    const start = Math.max(0, Math.min(Math.max(0, all.length - count), selectedIndex - Math.floor(count / 2)));
    const visible = all.slice(start, start + count);
    const visibleRegistered = visible.filter((entry) => entry.registered);
    const visibleRecent = visible.filter((entry) => !entry.registered);

    const renderRows = (entries: typeof visible, registeredRows: boolean) => entries.map(({ peer }, localIndex) => {
        const index = start + (registeredRows ? localIndex : visibleRegistered.length + localIndex);
        const selected = index === selectedIndex;
        return <ClickableRegion key={`${registeredRows ? "registered" : "recent"}:${peer.id}`} id={`peer:${registeredRows ? "registered" : "recent"}:${peer.id}`} registry={registry} width="100%" flexDirection="row" flexShrink={0} onClick={() => onOpen(index)}>
            <Text color={selected ? "cyan" : undefined} bold={selected}>{selected ? "› " : "  "}</Text>
            <Box width={20}><Text wrap="truncate" color={selected ? "cyan" : undefined}>{peer.displayName}</Text></Box>
            <Box width={11}><Text dimColor>{peer.displayId}</Text></Box>
            {peer.platformBotHint ? <Text color="yellow">Bot 标记</Text> : null}
            {!registeredRows && peer.lastSeenAt ? <Text dimColor>  {formatTime(peer.lastSeenAt)}</Text> : null}
        </ClickableRegion>;
    });

    return <Panel>
        <Text bold>已登记（{registered.length}）</Text>
        {visibleRegistered.length ? renderRows(visibleRegistered, true) : <Text dimColor>  {registered.length ? "当前范围内没有已登记账号" : "暂无已登记账号"}</Text>}
        {start > 0 ? <Text dimColor>  … 更早账号</Text> : null}
        <Text> </Text>
        <Text bold>最近发现（{recent.length}）</Text>
        {visibleRecent.length ? renderRows(visibleRecent, false) : <Text dimColor>  {recent.length ? "当前范围内没有最近发现账号" : "暂无最近发现账号"}</Text>}
        {start + visible.length < all.length ? <Text dimColor>  … 还有更多账号</Text> : null}
        <Text> </Text>
        <Text dimColor>稳定 ID 是唯一身份依据；Bot 标记仅供参考。</Text>
    </Panel>;
}
