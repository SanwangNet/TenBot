import React from "react";
import { Box, Text } from "ink";
import type { AutomatedPeerSummary } from "../../control/automated-peers.js";
import type { KnownMemberSummary } from "../../control/known-members.js";
import { formatTime } from "../i18n.js";
import { ClickableRegion } from "../components/clickable-region.js";
import { Panel } from "../components/panel.js";
import type { ClickableRegionRegistry } from "../mouse-input.js";
import { calculateAutomatedPeersLayout } from "../automated-peers-layout.js";

export function AutomatedPeersView({
    registered,
    recent,
    knownMembers,
    selectedIndex,
    visibleCount,
    width,
    registry,
    onOpen,
}: {
    registered: readonly AutomatedPeerSummary[];
    recent: readonly AutomatedPeerSummary[];
    knownMembers: readonly KnownMemberSummary[];
    selectedIndex: number;
    visibleCount: number;
    width: number;
    registry: ClickableRegionRegistry;
    onOpen(index: number): void;
}) {
    const all = [
        ...registered.map((peer) => ({ peer, registered: true })),
        ...recent.map((peer) => ({ peer, registered: false })),
    ];
    const layout = calculateAutomatedPeersLayout(width, visibleCount);
    const count = Math.max(1, layout.leftRows);
    const start = Math.max(0, Math.min(Math.max(0, all.length - count), selectedIndex - Math.floor(count / 2)));
    const visible = all.slice(start, start + count);
    const visibleRegistered = visible.filter((entry) => entry.registered);
    const visibleRecent = visible.filter((entry) => !entry.registered);
    const renderRows = (entries: typeof visible, registeredRows: boolean) => entries.map(({ peer }, localIndex) => {
        const index = start + (registeredRows ? localIndex : visibleRegistered.length + localIndex);
        const selected = index === selectedIndex;
        return <ClickableRegion key={`${registeredRows ? "registered" : "recent"}:${peer.id}`} id={`peer:${registeredRows ? "registered" : "recent"}:${peer.id}`} registry={registry} width="100%" flexDirection="row" flexShrink={0} onClick={() => onOpen(index)}>
            <Text color={selected ? "cyan" : undefined} bold={selected}>{selected ? "› " : "  "}</Text>
            <Box width={Math.max(10, layout.leftWidth - 36)} flexShrink={1}><Text wrap="truncate" color={selected ? "cyan" : undefined}>{peer.displayName}</Text></Box>
            <Box width={9} flexShrink={0}><Text dimColor>{peer.displayId}</Text></Box>
            {peer.platformBotHint ? <Text color="yellow">Bot 标记</Text> : null}
            {!registeredRows && peer.lastSeenAt ? <Text dimColor>  {formatTime(peer.lastSeenAt)}</Text> : null}
        </ClickableRegion>;
    });

    const directory = <>
        <Text bold>已登记（{registered.length}）</Text>
        {visibleRegistered.length ? renderRows(visibleRegistered, true) : <Text dimColor>  {registered.length ? "当前范围内没有已登记账号" : "暂无已登记账号"}</Text>}
        {start > 0 ? <Text dimColor>  … 更早账号</Text> : null}
        <Text> </Text>
        <Text bold>最近发现（{recent.length}）</Text>
        {visibleRecent.length ? renderRows(visibleRecent, false) : <Text dimColor>  {recent.length ? "当前范围内没有最近发现账号" : "暂无最近发现账号"}</Text>}
        {start + visible.length < all.length ? <Text dimColor>  … 还有更多账号</Text> : null}
        <Text> </Text>
        <Text dimColor>稳定 ID 是唯一身份依据；Bot 标记仅供参考。</Text>
    </>;
    const known = <>
        <Text bold>已知成员（{knownMembers.length}）</Text>
        {knownMembers.length === 0 ? <Text dimColor>暂无已知成员</Text> : knownMembers.slice(0, layout.knownMemberRows).map((member) => <Box key={member.id} flexDirection="row" flexShrink={0}>
            <Box width={Math.max(8, layout.rightWidth - 31)} flexShrink={1}><Text wrap="truncate">{member.displayName}</Text></Box>
            <Box width={10} flexShrink={0}><Text dimColor>{member.displayId}</Text></Box>
            <Box width={11} flexShrink={0}><Text dimColor>{formatTime(new Date(member.lastSeenAt).toISOString())}</Text></Box>
            <Text dimColor> {member.groupCount} 群</Text>
        </Box>)}
        {knownMembers.length > layout.knownMemberRows ? <Text dimColor>… 还有 {knownMembers.length - layout.knownMemberRows} 人</Text> : null}
        {knownMembers.length > 0 ? <Text dimColor>昵称 · 短 ID · 最近出现 · 群数</Text> : null}
    </>;

    if (layout.mode === "columns") return <Box flexDirection="row" flexGrow={1} minHeight={0}>
        <Box width={layout.leftWidth} flexShrink={0}><Panel flexGrow={1}>{directory}</Panel></Box>
        <Box width={layout.rightWidth} flexShrink={0}><Panel flexGrow={1}>{known}</Panel></Box>
    </Box>;
    return <Box flexDirection="column" flexGrow={1} minHeight={0}>
        <Box flexGrow={0} flexShrink={1}><Panel flexGrow={1}>{directory}</Panel></Box>
        <Box flexGrow={1} minHeight={0}><Panel flexGrow={1}>{known}</Panel></Box>
    </Box>;
}
