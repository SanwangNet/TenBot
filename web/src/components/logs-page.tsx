import React, { memo, useEffect, useMemo, useRef, useState } from "react";
import type { LogEntry } from "../api/types.js";
import { useLogs } from "../runtime/runtime-context.js";
import { filterLogs, isLogLevelFilter, loadLogLevelFilter, MAX_RENDERED_LOG_ENTRIES, saveLogLevelFilter, type LogLevelFilter } from "./log-state.js";

const levelFilters: Array<{ value: LogLevelFilter; label: string }> = [
    { value: "all", label: "所有级别" },
    { value: "all-level", label: "完整诊断" },
    { value: "debug", label: "调试" },
    { value: "info", label: "信息" },
    { value: "warn", label: "警告" },
    { value: "error", label: "错误" },
];

export function LogsPage() {
    const { state, dispatch } = useLogs();
    const [level, setLevel] = useState<LogLevelFilter>(() => loadLogLevelFilter());
    const [query, setQuery] = useState("");
    const viewportRef = useRef<HTMLDivElement>(null);
    const visibleEntries = useMemo(() => filterLogs(state.entries, level, query), [state.rowsRevision, level, query]);

    useEffect(() => {
        const viewport = viewportRef.current;
        if (state.follow && viewport) viewport.scrollTop = viewport.scrollHeight;
    }, [state.rowsRevision, state.follow]);

    useEffect(() => saveLogLevelFilter(level), [level]);

    const onScroll = () => {
        const viewport = viewportRef.current;
        if (!viewport) return;
        const atBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 28;
        dispatch({ type: "scroll-position", atBottom });
    };

    return <section className="logs-page">
        <div className="page-heading">
            <div><div className="eyebrow">TENBOT 控制台 / 实时日志</div><h1>日志</h1><p>通过运行时事件流实时接收。清空操作只影响当前浏览器视图。</p></div>
            <span className="log-buffer-count">缓存 {state.entries.length} / 5000</span>
        </div>

        <section className="panel logs-panel" aria-label="实时日志">
            <div className="logs-toolbar">
                <label className="log-filter-field">
                    <span>等级</span>
                    <select value={level} onChange={(event) => {
                        const value = event.currentTarget.value;
                        if (!isLogLevelFilter(value)) return;
                        setLevel(value);
                        saveLogLevelFilter(value);
                    }}>
                        {levelFilters.map((filter) => <option key={filter.value} value={filter.value}>{filter.label}</option>)}
                    </select>
                </label>
                <label className="log-search-field">
                    <span>搜索内容</span>
                    <input type="search" value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="筛选日志文本…" />
                </label>
                <div className="log-toolbar-actions">
                    <button className="button button-secondary" type="button" onClick={() => dispatch({ type: "set-follow", follow: !state.follow })}>
                        {state.follow ? "暂停跟随" : "恢复跟随"}
                    </button>
                    <button className="button button-secondary" type="button" onClick={() => dispatch({ type: "clear" })}>清空视图</button>
                </div>
            </div>

            {!state.follow && state.unseenCount > 0 && <button className="new-logs-banner" type="button" onClick={() => {
                dispatch({ type: "set-follow", follow: true });
                const viewport = viewportRef.current;
                if (viewport) viewport.scrollTop = viewport.scrollHeight;
            }}>
                有 {state.unseenCount} 条新日志 · 回到底部
            </button>}

            <div className="log-viewport" ref={viewportRef} onScroll={onScroll} role="log" aria-live="off" aria-label="运行时日志流" tabIndex={0}>
                {visibleEntries.length === 0
                    ? <div className="logs-empty">{state.entries.length === 0 ? "等待运行时日志…" : "没有匹配的日志"}</div>
                    : <LogRows entries={visibleEntries} />}
            </div>
            <div className="logs-footer">
                <span>日志持续接收并保留在浏览器缓存中；暂停跟随不会暂停接收。</span>
                <span>{visibleEntries.length > MAX_RENDERED_LOG_ENTRIES
                    ? `当前展示最近 ${MAX_RENDERED_LOG_ENTRIES} / ${visibleEntries.length} 条匹配日志`
                    : `${visibleEntries.length} 条匹配日志`}</span>
            </div>
        </section>
    </section>;
}

export function LogRows({ entries }: { entries: readonly LogEntry[] }) {
    const offset = Math.max(0, entries.length - MAX_RENDERED_LOG_ENTRIES);
    return React.createElement(React.Fragment, null, ...entries.slice(offset).map((entry, index) => React.createElement(LogLine, {
        key: `${entry.rowId ?? entry.timestamp}-${offset + index}`,
        entry,
        repeatCount: entry.repeatCount ?? 1,
        timestamp: entry.timestamp,
    })));
}

const LogLine = memo(function LogLine({ entry, repeatCount, timestamp }: { entry: LogEntry; repeatCount: number; timestamp: string }) {
    return <div className={`log-row log-${entry.level}`}>
        <time className="log-time" dateTime={timestamp}>{formatLogTime(timestamp)}</time>
        <span className="log-level">{entry.level.toUpperCase()}</span>
        <span className="log-text">{entry.text}</span>
        {repeatCount > 1 && <span className="log-repeat-count">× {repeatCount}</span>}
    </div>;
});

function formatLogTime(timestamp: string): string {
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime())
        ? timestamp.slice(0, 12)
        : date.toLocaleTimeString("zh-CN", { hour12: false });
}
