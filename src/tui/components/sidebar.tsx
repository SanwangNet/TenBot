import React from "react";
import { Box, Text } from "ink";
import type { TuiPage } from "../types.js";
import { PAGE_LABELS, PAGES } from "../i18n.js";

export function Sidebar({ selectedPage, activePage, focused }: {
    selectedPage: TuiPage;
    activePage: TuiPage;
    focused: boolean;
}) {
    return <Box flexDirection="column" width={18} borderStyle="single" borderRight paddingX={1} flexShrink={0}>
        <Text bold color={focused ? "cyan" : undefined}>导航</Text>
        {PAGES.map((page) => {
            const selected = page === selectedPage;
            const active = page === activePage;
            return <Text key={page} color={selected && focused ? "cyan" : active ? "white" : undefined} bold={selected && focused}>
                {selected && focused ? "› " : "  "}{PAGE_LABELS[page]}{active && !selected ? " ·" : ""}
            </Text>;
        })}
    </Box>;
}
