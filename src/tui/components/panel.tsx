import React from "react";
import { Box, Text } from "ink";

export function Panel({ title, children, flexGrow = 0, padding = 1 }: {
    title?: string;
    children: React.ReactNode;
    flexGrow?: number;
    padding?: number;
}) {
    return <Box flexDirection="column" borderStyle="round" paddingX={padding} flexGrow={flexGrow}>
        {title ? <Text bold>{title}</Text> : null}
        {children}
    </Box>;
}
