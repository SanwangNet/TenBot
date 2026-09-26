import { lazy, Suspense, useCallback, useRef, useState } from "react";
import { OverviewPage } from "./components/overview-page.js";
import { SettingsPage } from "./settings/settings-page.js";
import { LogsPage } from "./components/logs-page.js";
import { useRuntime } from "./runtime/runtime-context.js";
import { ModelPage } from "./components/model-page.js";
import { ConversationsPage } from "./conversations/conversations-page.js";
import { PeersPage } from "./components/peers-page.js";
import { useFeedback } from "./ui/feedback.js";
import { nextPage, type PageId } from "./navigation.js";

const EditorPage = lazy(async () => ({ default: (await import("./editor/editor-page.js")).EditorPage }));

const pages = [
    { id: "overview", label: "总览", mark: "◉" },
    { id: "models", label: "模型", mark: "◇" },
    { id: "prompts", label: "提示词", mark: "≡" },
    { id: "memes", label: "梗数据", mark: "✳" },
    { id: "conversations", label: "对话", mark: "▤" },
    { id: "peers", label: "自动账号", mark: "◎" },
    { id: "logs", label: "日志", mark: "⌁" },
    { id: "settings", label: "设置", mark: "⚙" },
] as const;

const connectionLabels = {
    connecting: "正在连接",
    online: "在线",
    reconnecting: "正在重新连接",
    offline: "离线",
} as const;

const qqLabels = {
    connecting: "连接中",
    connected: "已连接",
    disconnected: "未连接",
    error: "连接异常",
} as const;

export function App() {
    const [page, setPage] = useState<PageId>("overview");
    const [editorDirty, setEditorDirty] = useState(false);
    const [leaving, setLeaving] = useState(false);
    const transitionRef = useRef(false);
    const onEditorDirtyChange = useCallback((dirty: boolean) => setEditorDirty(dirty), []);
    const { confirm } = useFeedback();
    const { status, connection, error } = useRuntime();
    async function selectPage(requested: PageId) {
        if (page === requested || transitionRef.current) return;
        const confirmed = !editorDirty || await confirm({ title: "放弃未保存更改？", message: "离开编辑器会丢弃当前文件的未保存内容。", confirmLabel: "放弃更改", danger: true });
        const next = nextPage(page, requested, editorDirty, confirmed);
        if (next === page) return;
        transitionRef.current = true;
        setLeaving(true);
        if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
            await new Promise((resolve) => window.setTimeout(resolve, 120));
        }
        setEditorDirty(false);
        setPage(next);
        setLeaving(false);
        transitionRef.current = false;
    }

    return (
        <div className="app-shell">
            <aside className="sidebar" aria-label="主导航">
                <div className="brand">
                    <span className="brand-mark" aria-hidden="true">T</span>
                    <span className="brand-copy"><strong>TenBot</strong><small>WEB CONTROL</small></span>
                </div>
                <div className="nav-caption">控制台</div>
                <nav className="navigation">
                    {pages.map((item) => (
                        <button
                            className={`nav-item${page === item.id ? " active" : ""}`}
                            key={item.id}
                            type="button"
                            aria-current={page === item.id ? "page" : undefined}
                            onClick={() => void selectPage(item.id)}
                        >
                            <span className="nav-mark" aria-hidden="true">{item.mark}</span>
                            <span>{item.label}</span>
                            {page === item.id && <span className="nav-current" aria-hidden="true" />}
                        </button>
                    ))}
                </nav>
                <div className="sidebar-footer">
                    <span className="footer-dot" />
                    <span>TenBot Runtime Control</span>
                </div>
            </aside>

            <div className="main-column">
                <header className="topbar">
                    <div className="mobile-brand"><span className="brand-mark" aria-hidden="true">T</span><strong>TenBot</strong></div>
                    <div className="topbar-statuses">
                        <StatusPill label="QQ" value={status ? qqLabels[status.qq] : "读取中"} tone={qqTone(status?.qq)} />
                        <span className="topbar-model" title={status ? `${status.provider.id} · ${status.provider.model}` : undefined}>
                            <span className="model-indicator" />
                            <span>{status ? `${status.provider.id} / ${status.provider.model}` : "主模型读取中"}</span>
                        </span>
                        <StatusPill label="Runtime" value={connectionLabels[connection]} tone={connectionTone(connection)} />
                    </div>
                </header>

                <main className={`page-content${page === "prompts" || page === "memes" ? " page-content-editor" : ""}`}>
                    {error && (
                        <div className="error-banner" role="alert">
                            <span className="error-icon" aria-hidden="true">!</span>
                            <span>{error}</span>
                        </div>
                    )}
                    <div className={`page-enter${leaving ? " page-leave" : ""}`} key={page}>
                        {page === "overview" ? <OverviewPage />
                            : page === "models" ? <ModelPage />
                            : page === "prompts" || page === "memes" ? <Suspense fallback={<div className="panel">正在载入编辑器…</div>}><EditorPage mode={page} onDirtyChange={onEditorDirtyChange} /></Suspense>
                            : page === "conversations" ? <ConversationsPage />
                            : page === "peers" ? <PeersPage />
                            : page === "logs" ? <LogsPage />
                            : <SettingsPage />}
                    </div>
                </main>
            </div>
        </div>
    );
}

function StatusPill({ label, value, tone }: { label: string; value: string; tone: string }) {
    return <span className="status-pill"><span className={`status-dot ${tone}`} /> <span className="pill-label">{label}</span> <span>{value}</span></span>;
}

function qqTone(state: string | undefined) {
    if (state === "connected") return "good";
    if (state === "error") return "bad";
    return "muted";
}

function connectionTone(state: string) {
    if (state === "online") return "good";
    if (state === "offline") return "bad";
    return "warning";
}
