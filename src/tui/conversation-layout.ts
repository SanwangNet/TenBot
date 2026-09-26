import stringWidth from "string-width";
import type { ConversationItem } from "../control/conversation-timeline.js";
import { formatTime } from "./i18n.js";

export interface ConversationScrollAnchor {
    itemId: string;
    itemIndex: number;
    rowOffset: number;
}

export type ConversationRowTone = "header" | "peer" | "attempt" | "reply";

export interface ConversationVisualRow {
    itemId: string;
    itemIndex: number;
    rowOffset: number;
    side: "left" | "right";
    tone: ConversationRowTone;
    text: string;
}

export interface ConversationViewportLayout {
    totalRows: number;
    viewportRows: number;
    maxScrollRows: number;
    startRow: number;
    endRow: number;
    scrollRowsFromBottom: number;
    visibleRows: ConversationVisualRow[];
    anchor: ConversationScrollAnchor | null;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function graphemes(value: string): string[] {
    return [...graphemeSegmenter.segment(value)].map((entry) => entry.segment);
}

function truncateToWidth(value: string, maxWidth: number): string {
    value = value.replace(/[\r\n\t]/g, " ");
    if (stringWidth(value) <= maxWidth) return value;
    if (maxWidth <= 0) return "";
    const ellipsis = "…";
    const budget = Math.max(0, maxWidth - stringWidth(ellipsis));
    let result = "";
    let used = 0;
    for (const part of graphemes(value)) {
        const width = stringWidth(part);
        if (used + width > budget) break;
        result += part;
        used += width;
    }
    return result + (maxWidth >= stringWidth(ellipsis) ? ellipsis : "");
}

export function wrapTerminalText(value: string, maxWidth: number): string[] {
    const widthLimit = Math.max(1, Math.floor(maxWidth));
    const lines: string[] = [];
    for (const paragraph of value.replace(/\r\n?/g, "\n").split("\n")) {
        let line = "";
        let lineWidth = 0;
        for (const part of graphemes(paragraph)) {
            const partWidth = stringWidth(part);
            if (line && lineWidth + partWidth > widthLimit) {
                lines.push(line);
                line = "";
                lineWidth = 0;
            }
            line += part;
            lineWidth += partWidth;
        }
        lines.push(line);
    }
    return lines.length ? lines : [""];
}

export function measureConversationItem(item: ConversationItem, bubbleWidth: number, itemIndex = 0): ConversationVisualRow[] {
    if (item.type === "ai-attempt" && item.status === "completed") return [];

    const outerWidth = Math.max(5, Math.floor(bubbleWidth));
    const contentWidth = Math.max(1, outerWidth - 4);
    const side = item.type === "peer-message" ? "left" : "right";
    const tone: ConversationRowTone = item.type === "peer-message" ? "peer" : item.type === "ai-attempt" ? "attempt" : "reply";
    const speaker = item.type === "peer-message" ? item.displayName : "小尘";
    const headerWidth = Math.max(1, outerWidth);
    const header = truncateToWidth(`${speaker}  ${formatTime(item.timestamp)}`, headerWidth);
    const body = item.type === "ai-attempt"
        ? item.status === "generating" ? "生成中……" : item.status === "interrupted" ? "被中断" : item.failureStage === "send" ? "生成完成，发送失败" : "生成失败"
        : item.content;
    const lines = wrapTerminalText(body, contentWidth);
    const rows: ConversationVisualRow[] = [];
    const push = (text: string, rowTone: ConversationRowTone) => rows.push({
        itemId: item.id,
        itemIndex,
        rowOffset: rows.length,
        side,
        tone: rowTone,
        text,
    });

    push(header, "header");
    push(`┌${"─".repeat(outerWidth - 2)}┐`, tone);
    for (const line of lines) push(`│ ${line}${" ".repeat(Math.max(0, contentWidth - stringWidth(line)))} │`, tone);
    push(`└${"─".repeat(outerWidth - 2)}┘`, tone);
    return rows;
}

export function layoutConversationViewport(
    items: readonly ConversationItem[],
    bubbleWidth: number,
    viewportRows: number,
    anchor: ConversationScrollAnchor | null = null,
): ConversationViewportLayout {
    const rows = items.flatMap((item, index) => measureConversationItem(item, bubbleWidth, index));
    const visibleRowCount = Math.max(0, Math.floor(viewportRows));
    const maxScrollRows = Math.max(0, rows.length - visibleRowCount);
    let startRow = maxScrollRows;
    if (anchor && rows.length > 0) {
        const exact = rows.findIndex((row) => row.itemId === anchor.itemId && row.rowOffset === anchor.rowOffset);
        if (exact >= 0) startRow = exact;
        else {
            const fallbackIndex = Math.min(anchor.itemIndex, Math.max(0, items.length - 1));
            const fallback = rows.findIndex((row) => row.itemIndex >= fallbackIndex);
            startRow = fallback >= 0 ? fallback : Math.max(0, rows.length - 1);
        }
        startRow = Math.max(0, Math.min(maxScrollRows, startRow));
    }
    const endRow = Math.min(rows.length, startRow + visibleRowCount);
    const firstVisible = rows[startRow];
    const resolvedAnchor = !firstVisible || startRow >= maxScrollRows
        ? null
        : { itemId: firstVisible.itemId, itemIndex: firstVisible.itemIndex, rowOffset: firstVisible.rowOffset };
    return {
        totalRows: rows.length,
        viewportRows: visibleRowCount,
        maxScrollRows,
        startRow,
        endRow,
        scrollRowsFromBottom: maxScrollRows - startRow,
        visibleRows: rows.slice(startRow, endRow),
        anchor: resolvedAnchor,
    };
}

export type ConversationNavigation = "up" | "down" | "page-up" | "page-down" | "home" | "end";

export function moveConversationAnchor(
    items: readonly ConversationItem[],
    bubbleWidth: number,
    viewportRows: number,
    anchor: ConversationScrollAnchor | null,
    navigation: ConversationNavigation,
): ConversationScrollAnchor | null {
    const layout = layoutConversationViewport(items, bubbleWidth, viewportRows, anchor);
    let startRow = layout.startRow;
    if (navigation === "up") startRow--;
    else if (navigation === "down") startRow++;
    else if (navigation === "page-up") startRow -= Math.max(1, layout.viewportRows);
    else if (navigation === "page-down") startRow += Math.max(1, layout.viewportRows);
    else if (navigation === "home") startRow = 0;
    else startRow = layout.maxScrollRows;
    startRow = Math.max(0, Math.min(layout.maxScrollRows, startRow));
    if (startRow >= layout.maxScrollRows) return null;
    const first = items.flatMap((item, index) => measureConversationItem(item, bubbleWidth, index))[startRow];
    return first ? { itemId: first.itemId, itemIndex: first.itemIndex, rowOffset: first.rowOffset } : null;
}

export function calculateBubbleWidth(viewportWidth: number): number {
    const available = Math.max(1, Math.floor(viewportWidth));
    return Math.min(available, Math.max(5, Math.floor(available * 0.78)));
}
