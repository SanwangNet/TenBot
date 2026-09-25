import React from "react";
import { Box, Text, useWindowSize } from "ink";

export function Footer({ focus, settings, automatedPeers, conversations, logs, notice }: { focus: "sidebar" | "main"; settings?: boolean; automatedPeers?: boolean; conversations?: boolean; logs?: boolean; notice?: string }) {
    const { columns } = useWindowSize();
    const navigation = automatedPeers
        ? "↑↓ 选择  Enter 详情  A 添加  Del 删除"
        : focus === "sidebar" ? "↑↓ 选择  Enter 打开"
          : settings ? "↑↓ 选择  ←→ 切换卡片  Enter 修改/应用"
            : conversations ? "←→ 切换对话  ↑↓ 翻行  PgUp/PgDn 翻页  Home/End 定位"
              : logs ? "↑↓ 滚动  PgUp/PgDn 翻页  Home/End 定位"
                : "↑↓ 查看  Esc 返回";
    const shortcuts = "Tab 切换  P 提示词  M 梗数据  R 重载  ? 帮助  Q 退出";
    return <Box flexDirection="column" borderStyle="single" borderTop flexShrink={0} paddingX={1}>
        <Box flexDirection={columns < 96 ? "column" : "row"}>
            <Text dimColor wrap="truncate">{navigation}</Text>
            <Text dimColor wrap="truncate">{columns < 96 ? shortcuts : `  ${shortcuts}`}</Text>
        </Box>
        {notice ? <Text color="yellow">! {notice}</Text> : null}
    </Box>;
}
