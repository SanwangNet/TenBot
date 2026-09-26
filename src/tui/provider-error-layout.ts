import type { ProviderErrorNotice } from "../control/provider-error.js";
import { calculateCenteredModalBounds } from "./modal-layout.js";
import { wrapTerminalText } from "./conversation-layout.js";

export type ProviderErrorScrollKey = "up" | "down" | "page-up" | "page-down" | "home" | "end";

export interface ProviderErrorDetailsLayout {
    compact: boolean;
    metadataLines: string[];
    contentLines: string[];
    visibleLines: string[];
    viewportRows: number;
    scrollOffset: number;
    maxScrollOffset: number;
    statusLine?: string;
    showActions: boolean;
}

function wrapped(value: string, width: number): string[] {
    return wrapTerminalText(value, Math.max(1, width));
}

export function layoutProviderErrorDetails(
    notice: ProviderErrorNotice,
    width: number,
    maxHeight: number,
    count: number,
    requestedScrollOffset: number,
): ProviderErrorDetailsLayout {
    const compact = maxHeight < 18;
    const contentWidth = Math.max(1, Math.floor(width) - 6);
    const metadata = compact
        ? [
            `${notice.provider} · ${notice.model}`,
            `${notice.tenbotCode} · HTTP ${notice.status ?? "未知"}`,
        ]
        : [
            `模型提供商  ${notice.provider}`,
            `模型        ${notice.model}`,
            `TenBot 错误码  ${notice.tenbotCode}`,
            `HTTP 状态   ${notice.status ?? "未知"}`,
            `错误代码    ${notice.code ?? "未知"}`,
            `可重试      ${notice.retryable === undefined ? "未知" : notice.retryable ? "是" : "否"}`,
        ].flatMap((line) => wrapped(line, contentWidth));
    const contentLines = [
        ...wrapped(`错误摘要：${notice.message}`, contentWidth),
        "",
        ...(notice.details
            ? ["安全详情：", ...wrapped(notice.details, contentWidth)]
            : ["暂无更多安全详情。"]),
        ...(count > 1 ? ["", `另有 ${count - 1} 个模型错误`] : []),
    ];

    // The frame owns title, border, and optional vertical padding. Reserve its
    // rows before slicing; details and actions never compete for the same rows.
    const frameChromeRows = 2 + (compact ? 0 : 2);
    const innerRows = Math.max(0, Math.floor(maxHeight) - frameChromeRows - 1);
    const showActions = innerRows >= 2;
    const metadataRows = Math.min(metadata.length, Math.max(0, innerRows - (showActions ? 1 : 0) - 1));
    const visibleMetadata = metadata.slice(0, metadataRows);
    const afterMetadataAndActions = innerRows - metadataRows - (showActions ? 1 : 0);
    const showStatus = afterMetadataAndActions >= 2;
    const viewportRows = Math.max(1, afterMetadataAndActions - (showStatus ? 1 : 0));
    const maxScrollOffset = Math.max(0, contentLines.length - viewportRows);
    const scrollOffset = Math.max(0, Math.min(maxScrollOffset, Math.floor(requestedScrollOffset)));
    const visibleLines = contentLines.slice(scrollOffset, scrollOffset + viewportRows);
    return {
        compact,
        metadataLines: visibleMetadata,
        contentLines,
        visibleLines,
        viewportRows,
        scrollOffset,
        maxScrollOffset,
        ...(showStatus ? {
            statusLine: maxScrollOffset === 0
                ? `完整内容 · ${contentLines.length} 行`
                : `行 ${scrollOffset + 1}-${Math.min(contentLines.length, scrollOffset + viewportRows)} / ${contentLines.length} · ↑↓滚动 PgUp/PgDn翻页 Home/End定位`,
        } : {}),
        showActions,
    };
}

export function moveProviderErrorDetailsScroll(
    notice: ProviderErrorNotice,
    count: number,
    columns: number,
    rows: number,
    currentOffset: number,
    key: ProviderErrorScrollKey,
): number {
    const bounds = calculateCenteredModalBounds(columns, rows, 72, rows - 2);
    const layout = layoutProviderErrorDetails(notice, bounds.width, bounds.height, count, currentOffset);
    if (key === "up") return Math.max(0, layout.scrollOffset - 1);
    if (key === "down") return Math.min(layout.maxScrollOffset, layout.scrollOffset + 1);
    if (key === "page-up") return Math.max(0, layout.scrollOffset - Math.max(1, layout.viewportRows));
    if (key === "page-down") return Math.min(layout.maxScrollOffset, layout.scrollOffset + Math.max(1, layout.viewportRows));
    if (key === "home") return 0;
    return layout.maxScrollOffset;
}

export function providerErrorSummaryPreview(notice: ProviderErrorNotice, width: number, maxHeight: number, count: number): {
    lines: string[];
    hasMore: boolean;
} {
    const full = wrapped(notice.message, Math.max(1, Math.floor(width) - 6));
    const frameChromeRows = 4;
    const fixedRows = 1 + 1 + 5 + 1 + (count > 1 ? 1 : 0) + 1 + 1;
    const budget = Math.max(1, Math.floor(maxHeight) - frameChromeRows - 1 - fixedRows);
    const hasMore = full.length > budget;
    const visibleCount = hasMore ? Math.max(1, budget - 1) : budget;
    return { lines: full.slice(0, visibleCount), hasMore };
}
