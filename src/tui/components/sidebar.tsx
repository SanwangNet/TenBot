import React from "react";
import { Box, Text } from "ink";
import type { TuiPage } from "../types.js";
import { PAGE_LABELS, PAGES } from "../i18n.js";
import { ClickableRegion } from "./clickable-region.js";
import type { ClickableRegionRegistry } from "../mouse-input.js";

export function Sidebar({ selectedPage, activePage, focused, registry, onSelectPage }: {
    selectedPage: TuiPage;
    activePage: TuiPage;
    focused: boolean;
    registry: ClickableRegionRegistry;
    onSelectPage(page: TuiPage): void;
}) {
    return <Box flexDirection="column" width={18} borderStyle="single" borderRight paddingX={1} flexShrink={0}>
        <Text bold color={focused ? "cyan" : undefined}>导航</Text>
        {PAGES.map((page) => {
            const selected = page === selectedPage;
            const active = page === activePage;
            return <ClickableRegion key={page} id={`sidebar:${page}`} registry={registry} width={14} flexShrink={0} onClick={() => onSelectPage(page)}>
                <Text color={selected && focused ? "cyan" : active ? "white" : undefined} bold={selected && focused}>
                    {selected && focused ? "› " : "  "}{PAGE_LABELS[page]}{active && !selected ? " ·" : ""}
                </Text>
            </ClickableRegion>;
        })}
    </Box>;
}
