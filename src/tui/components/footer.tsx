import React from "react";
import { Box, Text } from "ink";

export function Footer({ focus, notice }: { focus: "sidebar" | "main"; notice?: string }) {
    return <Box flexDirection="column" borderStyle="single" borderTop flexShrink={0} paddingX={1}>
        <Box>
            <Text dimColor>{focus === "sidebar" ? "↑↓ 选择  Enter 打开" : "↑↓ 查看  Esc 返回"}</Text>
            <Text dimColor>  P 提示词  M 梗数据  R 重载  ? 帮助  Q 退出</Text>
        </Box>
        {notice ? <Text color="yellow">! {notice}</Text> : null}
    </Box>;
}
