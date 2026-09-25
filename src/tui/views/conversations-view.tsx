import React from "react";
import { Box, Text } from "ink";
import type { ConversationItem, ConversationSummary } from "../../control/conversation-timeline.js";
import { formatTime } from "../i18n.js";
import { ClickableRegion } from "../components/clickable-region.js";
import { Panel } from "../components/panel.js";
import type { ClickableRegionRegistry } from "../mouse-input.js";

export function ConversationsView({
    conversations, selectedIndex, items, offset, visibleLines, columns, registry, onSwitch, onScroll,
}: {
    conversations: readonly ConversationSummary[];
    selectedIndex: number;
    items: readonly ConversationItem[];
    offset: number;
    visibleLines: number;
    columns: number;
    registry: ClickableRegionRegistry;
    onSwitch(delta: number): void;
    onScroll(offset: number): void;
}) {
    const selected = conversations[selectedIndex];
    const end = Math.max(0, items.length - offset);
    const start = Math.max(0, end - visibleLines);
    const visible = items.slice(start, end);
    const bubbleWidth = Math.max(20, Math.min(Math.floor(columns * 0.78), columns - 4));
    return <Panel flexGrow={1}>
        <Box flexDirection="row" alignItems="center">
            <Text bold>对话  </Text>
            <ClickableRegion id="conversation:previous" registry={registry} paddingX={1} onClick={() => onSwitch(-1)}>
                <Text color="cyan">◀</Text>
            </ClickableRegion>
            <Text color={selected ? "cyan" : undefined}>{selected?.label ?? "暂无消息"}</Text>
            <ClickableRegion id="conversation:next" registry={registry} paddingX={1} onClick={() => onSwitch(1)}>
                <Text color="cyan">▶</Text>
            </ClickableRegion>
            <Text dimColor>{conversations.length ? `${selectedIndex + 1}/${conversations.length}` : ""}</Text>
        </Box>
        <Box flexDirection="column" flexGrow={1} minHeight={0}>
            {visible.length === 0 ? <Text dimColor>等待群消息和模型回复……</Text> : visible.map((item) => {
                if (item.type === "group-message") return <Box key={item.id} flexDirection="column" width="100%" alignItems="flex-start" flexShrink={0}>
                    <Text dimColor>{item.displayName}  {formatTime(item.timestamp)}</Text>
                    <Box width={bubbleWidth} borderStyle="round" borderColor="gray" paddingX={1}>
                        <Text wrap="wrap">{item.content}</Text>
                    </Box>
                </Box>;
                if (item.type === "ai-attempt") return <Box key={item.id} flexDirection="column" width="100%" alignItems="flex-end" flexShrink={0}>
                    <Text dimColor>小尘  {formatTime(item.timestamp)}</Text>
                    <Box width={bubbleWidth} borderStyle="round" borderColor={item.status === "failed" ? "yellow" : "gray"} paddingX={1} flexDirection="column">
                        <Text color="gray">{item.status === "generating" ? "生成中……" : item.status === "interrupted" ? "被中断" : item.status === "failed" ? (item.failureStage === "send" ? "生成完成，发送失败" : "生成失败") : "生成完成"}</Text>
                    </Box>
                </Box>;
                return <Box key={item.id} flexDirection="column" width="100%" alignItems="flex-end" flexShrink={0}>
                    <Text dimColor>小尘  {formatTime(item.timestamp)}</Text>
                    <Box width={bubbleWidth} borderStyle="round" borderColor="cyan" paddingX={1}>
                        <Text wrap="wrap">{item.content}</Text>
                    </Box>
                </Box>;
            })}
        </Box>
        {items.length > visibleLines ? <Text dimColor>位置：{start + 1}-{end} / {items.length}  ·  ↑↓ 翻行  Home/End 定位</Text> : null}
    </Panel>;
}
