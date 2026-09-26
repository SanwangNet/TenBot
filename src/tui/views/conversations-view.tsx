import React, { useEffect, useRef } from "react";
import { Box, Text, measureElement, useBoxMetrics } from "ink";
import type { DOMElement } from "ink";
import type { ConversationItem, ConversationSummary } from "../../control/conversation-timeline.js";
import { formatTime } from "../i18n.js";
import { ClickableRegion } from "../components/clickable-region.js";
import { Panel } from "../components/panel.js";
import type { ClickableRegionRegistry } from "../mouse-input.js";
import { calculateBubbleWidth, layoutConversationViewport, type ConversationScrollAnchor } from "../conversation-layout.js";

export function ConversationsView({
    conversations, selectedIndex, items, anchor, registry, onSwitch, onViewportMeasure,
}: {
    conversations: readonly ConversationSummary[];
    selectedIndex: number;
    items: readonly ConversationItem[];
    anchor: ConversationScrollAnchor | null;
    registry: ClickableRegionRegistry;
    onSwitch(delta: number): void;
    onViewportMeasure(conversationId: string | undefined, viewportRows: number, bubbleWidth: number): void;
}) {
    const selected = conversations[selectedIndex];
    const viewportRef = useRef<DOMElement | null>(null);
    const metrics = useBoxMetrics(viewportRef);
    const viewportRows = metrics.hasMeasured ? Math.max(0, Math.floor(metrics.height)) : 0;
    const viewportWidth = metrics.hasMeasured && viewportRef.current ? Math.max(0, Math.floor(measureElement(viewportRef.current).width)) : 0;
    const bubbleWidth = calculateBubbleWidth(viewportWidth);
    const layout = layoutConversationViewport(items, bubbleWidth, viewportRows, anchor);

    useEffect(() => {
        if (metrics.hasMeasured) onViewportMeasure(selected?.conversationId, viewportRows, bubbleWidth);
    }, [bubbleWidth, metrics.hasMeasured, onViewportMeasure, selected?.conversationId, viewportRows]);

    return <Panel flexGrow={1}>
        <Box flexDirection="row" alignItems="center" flexShrink={0}>
            <Text bold>对话  </Text>
            <ClickableRegion id="conversation:previous" registry={registry} paddingX={1} onClick={() => onSwitch(-1)}>
                <Text color="cyan">◀</Text>
            </ClickableRegion>
            <Text color={selected ? "cyan" : undefined} wrap="truncate">{selected?.label ?? "暂无消息"}</Text>
            <ClickableRegion id="conversation:next" registry={registry} paddingX={1} onClick={() => onSwitch(1)}>
                <Text color="cyan">▶</Text>
            </ClickableRegion>
            <Text dimColor>{conversations.length ? `${selectedIndex + 1}/${conversations.length}` : ""}</Text>
        </Box>
        <Box ref={viewportRef} flexDirection="column" flexGrow={1} minHeight={0} overflow="hidden">
            {layout.visibleRows.length === 0
                ? viewportRows > 0 ? <Box height={1} flexShrink={0}><Text dimColor>等待消息……</Text></Box> : null
                : layout.visibleRows.map((row) => <Box
                    key={`${row.itemId}:${row.rowOffset}`}
                    width={viewportWidth}
                    height={1}
                    flexShrink={0}
                    flexDirection="row"
                    justifyContent={row.side === "right" ? "flex-end" : "flex-start"}
                    overflow="hidden"
                >
                    <Text
                        dimColor={row.tone === "header" || row.tone === "attempt"}
                        color={row.tone === "reply" ? "cyan" : row.tone === "peer" ? "gray" : undefined}
                        wrap="truncate"
                    >{row.text}</Text>
                </Box>)}
        </Box>
        <Text dimColor wrap="truncate">{layout.totalRows === 0
            ? "等待消息"
            : `行 ${layout.startRow + 1}-${layout.endRow} / ${layout.totalRows} · ↑↓ 翻行 · End 回到最新`}</Text>
    </Panel>;
}
