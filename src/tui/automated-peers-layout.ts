export interface AutomatedPeersLayout {
    mode: "columns" | "stacked";
    leftWidth: number;
    rightWidth: number;
    leftRows: number;
    knownMemberRows: number;
}

/** Keep both lists readable; split the page only after its content column is wide enough. */
export function calculateAutomatedPeersLayout(width: number, visibleRows: number): AutomatedPeersLayout {
    const safeWidth = Math.max(1, Math.floor(width));
    const rows = Math.max(1, Math.floor(visibleRows));
    if (safeWidth >= 96) {
        const leftWidth = Math.floor(safeWidth * 0.55);
        return { mode: "columns", leftWidth, rightWidth: safeWidth - leftWidth, leftRows: rows, knownMemberRows: rows };
    }
    return {
        mode: "stacked",
        leftWidth: safeWidth,
        rightWidth: safeWidth,
        leftRows: Math.max(2, Math.floor(rows * 0.3)),
        knownMemberRows: Math.max(1, Math.floor(rows * 0.2)),
    };
}
