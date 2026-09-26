import { useEffect, useRef, useState } from "react";
import { apiClient } from "../api/client.js";
import type { ConversationItem, ConversationSummary } from "../api/types.js";
import { useConversations } from "../runtime/runtime-context.js";
import "./conversations.css";

const kindLabels: Record<ConversationSummary["kind"], string> = { group: "群聊", private: "私聊" };
const attemptLabels: Record<Extract<ConversationItem, { type: "ai-attempt" }>["status"], string> = {
    generating: "生成中", interrupted: "已中断", completed: "已完成", failed: "失败",
};

export function ConversationsPage() {
    const { state, dispatch } = useConversations();
    const [selected, setSelected] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [follow, setFollow] = useState(true);
    const timelineRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const controller = new AbortController();
        void apiClient.getConversations(controller.signal).then((summaries) => {
            dispatch({ type: "list", summaries });
            setSelected((current) => current ?? summaries[0]?.conversationId ?? null);
        }).catch(() => { if (!controller.signal.aborted) setError("无法读取对话列表"); });
        return () => controller.abort();
    }, [dispatch]);
    useEffect(() => {
        if (!selected || state.timelines[selected]) return;
        const controller = new AbortController();
        const atRevision = state.revision;
        void apiClient.getConversation(selected, controller.signal).then((items) => dispatch({ type: "timeline", id: selected, items, atRevision }))
            .catch(() => { if (!controller.signal.aborted) setError("无法读取对话时间线"); });
        return () => controller.abort();
    }, [selected, state.revision, state.timelines, dispatch]);
    const items = selected ? state.timelines[selected] : undefined;
    const current = state.summaries.find((summary) => summary.conversationId === selected);
    useEffect(() => { if (follow && timelineRef.current) timelineRef.current.scrollTop = timelineRef.current.scrollHeight; }, [items?.length, selected, follow]);
    useEffect(() => { if (!selected && state.summaries.length) setSelected(state.summaries[0]!.conversationId); }, [selected, state.summaries]);
    return <section className="conversations-page">
        <div className="page-heading"><div><div className="eyebrow">CONTROL PLANE / TIMELINE</div><h1>对话</h1><p>Runtime 当前保留的会话与消息时间线。</p></div><span className="page-count">{state.summaries.length} 个会话</span></div>
        {error && <div className="settings-feedback error" role="alert">{error}</div>}
        <div className="conversation-layout panel">
            <aside className="conversation-list" aria-label="会话列表">
                <div className="conversation-list-heading">最近会话</div>
                {state.summaries.length === 0 && <p className="empty-message">暂无会话，等待 QQ 消息。</p>}
                {state.summaries.map((summary) => <button type="button" key={summary.conversationId} className={`conversation-choice${selected === summary.conversationId ? " active" : ""}`} onClick={() => { setSelected(summary.conversationId); setFollow(true); }}>
                    <strong>{summary.label}</strong><span>{kindLabels[summary.kind]} · {formatTime(summary.lastActivityAt)}</span>
                </button>)}
            </aside>
            <div className="conversation-detail">
                {current ? <>
                    <div className="conversation-detail-heading"><div><h2>{current.label}</h2><span>{kindLabels[current.kind]} · {current.conversationId}</span></div><span className="live-indicator">实时更新</span></div>
                    <div className="conversation-timeline" ref={timelineRef} onScroll={() => { const element = timelineRef.current; if (element) setFollow(element.scrollHeight - element.scrollTop - element.clientHeight < 40); }} role="log" aria-label="对话时间线">
                        {items?.length ? items.map((item) => <TimelineItem key={item.id} item={item} />) : <p className="empty-message">{items ? "暂无消息" : "正在载入时间线…"}</p>}
                    </div>
                    {!follow && <button className="conversation-follow" type="button" onClick={() => { setFollow(true); if (timelineRef.current) timelineRef.current.scrollTop = timelineRef.current.scrollHeight; }}>回到底部 · 继续跟随</button>}
                </> : <div className="empty-message center-empty">选择一个会话查看时间线</div>}
            </div>
        </div>
    </section>;
}

function TimelineItem({ item }: { item: ConversationItem }) {
    if (item.type === "ai-attempt") return <div className={`attempt-row attempt-${item.status}`}><span>AI Attempt</span><strong>{attemptLabels[item.status]}{item.failureStage ? ` · ${item.failureStage}` : ""}</strong><time>{formatTime(item.timestamp)}</time></div>;
    const bot = item.type === "ai-reply";
    return <div className={`message-row ${bot ? "bot-message" : "peer-message"}`}>
        <div className="message-meta"><strong>{bot ? "TenBot" : item.displayName}</strong><time>{formatTime(item.timestamp)}</time></div>
        <div className="message-bubble">{item.content}</div>
    </div>;
}

function formatTime(value: string) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}
