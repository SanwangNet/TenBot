import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { OverviewPage } from "./components/overview-page.js";
import { SettingsPage } from "./settings/settings-page.js";
import { LogsPage } from "./components/logs-page.js";
import { useRuntime } from "./runtime/runtime-context.js";
import { ModelPage } from "./components/model-page.js";
import { ConversationsPage } from "./conversations/conversations-page.js";
import { MembersPage } from "./components/members-page.js";
import { useFeedback } from "./ui/feedback.js";
import { appRouteHash, nextPage, parseAppRoute, type AppRoute, type PageId, type SettingsSection } from "./navigation.js";
import type { AuthMeResponse } from "./api/types.js";
import { apiClient } from "./api/client.js";

const EditorPage = lazy(async () => ({ default: (await import("./editor/editor-page.js")).EditorPage }));
const MemeLibraryPage = lazy(async () => ({ default: (await import("./components/meme-library-page.js")).MemeLibraryPage }));

const pages = [
    { id: "overview", label: "总览", mark: "◉" },
    { id: "models", label: "模型", mark: "◇" },
    { id: "prompts", label: "提示词", mark: "≡" },
    { id: "memes", label: "梗数据", mark: "✳" },
    { id: "meme-library", label: "表情包", mark: "▣" },
    { id: "conversations", label: "对话", mark: "▤" },
    { id: "members", label: "成员", mark: "◎" },
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

export function App({ user, onLogout }: { user: AuthMeResponse["user"]; onLogout(): void }) {
    const [route, setRoute] = useState<AppRoute>(() => parseAppRoute(typeof window === "undefined" ? "" : window.location.hash));
    const { page, settingsSection } = route;
    const [editorDirty, setEditorDirty] = useState(false);
    const [settingsDirty, setSettingsDirty] = useState(false);
    const [leaving, setLeaving] = useState(false);
    const transitionRef = useRef(false);
    const routeRef = useRef(route);
    routeRef.current = route;
    const onEditorDirtyChange = useCallback((dirty: boolean) => setEditorDirty(dirty), []);
    const onSettingsDirtyChange = useCallback((dirty: boolean) => setSettingsDirty(dirty), []);
    const { confirm, notify } = useFeedback();
    const { status, connection, error } = useRuntime();
    async function selectPage(requested: PageId) {
        if (page === requested || transitionRef.current) return;
        const hasUnsaved = editorDirty || (page === "settings" && settingsDirty);
        const confirmed = !hasUnsaved || await confirm({
            title: "放弃未保存更改？",
            message: editorDirty ? "离开编辑器会丢弃当前文件的未保存内容。" : "离开设置中心会丢弃尚未保存的设置草稿。",
            confirmLabel: "放弃更改",
            danger: true,
        });
        const next = nextPage(page, requested, hasUnsaved, confirmed);
        if (next === page) return;
        transitionRef.current = true;
        setLeaving(true);
        if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
            await new Promise((resolve) => window.setTimeout(resolve, 120));
        }
        setEditorDirty(false);
        setSettingsDirty(false);
        const nextRoute = { page: next, settingsSection };
        routeRef.current = nextRoute;
        window.history.pushState({ tenbotRoute: true }, "", appRouteHash(nextRoute));
        setRoute(nextRoute);
        setLeaving(false);
        transitionRef.current = false;
    }

    const selectSettingsSection = useCallback((section: SettingsSection) => {
        const current = routeRef.current;
        if (current.page !== "settings" || current.settingsSection === section) return;
        const nextRoute = { page: "settings" as const, settingsSection: section };
        routeRef.current = nextRoute;
        window.history.pushState({ tenbotRoute: true }, "", appRouteHash(nextRoute));
        setRoute(nextRoute);
    }, []);

    useEffect(() => {
        const handlePopState = () => {
            const requested = parseAppRoute(window.location.hash);
            const current = routeRef.current;
            if (requested.page === current.page && requested.settingsSection === current.settingsSection) return;
            if (transitionRef.current) {
                window.history.pushState({ tenbotRoute: true }, "", appRouteHash(current));
                return;
            }
            const needsConfirmation = editorDirty || (current.page === "settings" && requested.page !== "settings" && settingsDirty);
            if (!needsConfirmation) {
                routeRef.current = requested;
                setRoute(requested);
                setEditorDirty(false);
                if (current.page === "settings" && requested.page !== "settings") setSettingsDirty(false);
                return;
            }
            transitionRef.current = true;
            void confirm({
                title: "放弃未保存更改？",
                message: editorDirty ? "离开编辑器会丢弃当前文件的未保存内容。" : "离开设置中心会丢弃尚未保存的设置草稿。",
                confirmLabel: "放弃更改",
                danger: true,
            }).then((confirmed) => {
                if (confirmed) {
                    routeRef.current = requested;
                    setRoute(requested);
                    setEditorDirty(false);
                    if (current.page === "settings" && requested.page !== "settings") setSettingsDirty(false);
                } else {
                    window.history.pushState({ tenbotRoute: true }, "", appRouteHash(current));
                }
            }).finally(() => { transitionRef.current = false; });
        };
        window.addEventListener("popstate", handlePopState);
        return () => window.removeEventListener("popstate", handlePopState);
    }, [confirm, editorDirty, settingsDirty]);

    useEffect(() => {
        const handleBeforeUnload = (event: BeforeUnloadEvent) => {
            if (!editorDirty && !settingsDirty) return;
            event.preventDefault();
            event.returnValue = "";
        };
        window.addEventListener("beforeunload", handleBeforeUnload);
        return () => window.removeEventListener("beforeunload", handleBeforeUnload);
    }, [editorDirty, settingsDirty]);

    async function logout() {
        try { await apiClient.logout(); onLogout(); }
        catch { notify("error", "退出登录失败，请检查网络后重试"); }
    }

    return (
        <div className="app-shell">
            <aside className="sidebar" aria-label="主导航">
                <div className="brand">
                    <span className="brand-mark" aria-hidden="true">T</span>
                    <span className="brand-copy"><strong>TenBot</strong><small>网页控制台</small></span>
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
                    <span>TenBot 运行时控制</span>
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
                        <StatusPill label="运行时" value={connectionLabels[connection]} tone={connectionTone(connection)} />
                    </div>
                    <div className="auth-profile">
                        {user.avatarUrl && <img src={user.avatarUrl} alt="" referrerPolicy="no-referrer" />}
                        <span>{user.login}</span>
                        <button className="button button-secondary" type="button" onClick={() => void logout()}>退出</button>
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
                            : page === "meme-library" ? <Suspense fallback={<div className="panel">正在载入表情包…</div>}><MemeLibraryPage /></Suspense>
                            : page === "conversations" ? <ConversationsPage />
                            : page === "members" ? <MembersPage />
                            : page === "logs" ? <LogsPage />
                            : <SettingsPage section={settingsSection} onSectionChange={selectSettingsSection} onDirtyChange={onSettingsDirtyChange} />}
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
