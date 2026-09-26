import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { LogEntry } from "../api/types.js";
import { useLogs } from "../runtime/runtime-context.js";
import { filterLogs, type LogLevelFilter } from "./log-state.js";

const levelFilters: Array<{ value: LogLevelFilter; label: string }> = [
    { value: "all", label: "全部" },
    { value: "debug", label: "调试" },
    { value: "info", label: "信息" },
    { value: "error", label: "错误" },
];

export function LogsPage() {
    const { state, dispatch } = useLogs();
    const [level, setLevel] = useState<LogLevelFilter>("all");
    const [query, setQuery] = useState("");
    const viewportRef = useRef<HTMLDivElement>(null);
    const visibleEntries = useMemo(() => filterLogs(state.entries, level, query), [state.entries, level, query]);

    useEffect(() => {
        const viewport = viewportRef.current;
        if (state.follow && viewport) viewport.scrollTop = viewport.scrollHeight;
    }, [state.entries, state.follow]);

    const onScroll = () => {
        const viewport = viewportRef.current;
        if (!viewport) return;
        const atBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 28;
        dispatch({ type: "scroll-position", atBottom });
    };

    return <section className="logs-page">
        <div className="page-heading">
            <div><div className="eyebrow">TENBOT CONTROL / STREAM</div><h1>日志</h1><p>通过 Runtime SSE 实时接收。清空操作只影响当前浏览器视图。</p></div>
            <span className="log-buffer-count">缓存 {state.entries.length} / 1000</span>
        </div>

        <section className="panel logs-panel" aria-label="实时日志">
            <div className="logs-toolbar">
                <label className="log-filter-field">
                    <span>等级</span>
                    <select value={level} onChange={(event) => setLevel(event.currentTarget.value as LogLevelFilter)}>
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

            <div className="log-viewport" ref={viewportRef} onScroll={onScroll} role="log" aria-live="off" aria-label="Runtime 日志流" tabIndex={0}>
                {visibleEntries.length === 0
                    ? <div className="logs-empty">{state.entries.length === 0 ? "等待 Runtime 日志…" : "没有匹配的日志"}</div>
                    : visibleEntries.map((entry, index) => <LogLine key={`${entry.timestamp}-${index}`} entry={entry} />)}
            </div>
            <div className="logs-footer">
                <span>日志持续接收并保留在浏览器缓存中；暂停跟随不会暂停接收。</span>
                <span>{visibleEntries.length} 条可见</span>
            </div>
        </section>
    </section>;
}

const LogLine = memo(function LogLine({ entry }: { entry: LogEntry }) {
    return <div className={`log-row log-${entry.level}`}>
        <time className="log-time" dateTime={entry.timestamp}>{formatLogTime(entry.timestamp)}</time>
        <span className="log-level">{entry.level.toUpperCase()}</span>
        <span className="log-text">{entry.text}</span>
    </div>;
});

function formatLogTime(timestamp: string): string {
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime())
        ? timestamp.slice(0, 12)
        : date.toLocaleTimeString("zh-CN", { hour12: false });
}
