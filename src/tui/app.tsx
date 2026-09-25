import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput, useWindowSize } from "ink";
import type { RuntimeStatus } from "../control/runtime-status.js";
import type { ReloadResult, TenBotControl } from "../control/tenbot-control.js";
import type { ProviderErrorNotice } from "../control/provider-error.js";
import type { RuntimeEvent } from "../control/runtime-event.js";
import type { LogEntry } from "../shared/logger.js";
import { MAX_TUI_LOG_ENTRIES } from "../control/tenbot-control.js";
import { Footer } from "./components/footer.js";
import { ModalLayer } from "./components/modal.js";
import { Sidebar } from "./components/sidebar.js";
import { TopBar } from "./components/top-bar.js";
import { ConversationsView } from "./views/conversations-view.js";
import { LogsView } from "./views/logs-view.js";
import { MemesView } from "./views/memes-view.js";
import { ModelView } from "./views/model-view.js";
import { OverviewView } from "./views/overview-view.js";
import { PromptView } from "./views/prompt-view.js";
import { SettingsView } from "./views/settings-view.js";
import { PAGE_LABELS, PAGES } from "./i18n.js";
import { clampLogOffset, initialTuiState, type ModalState, type TuiState } from "./state.js";
import type { TuiPage } from "./types.js";

export interface TenBotTuiProps {
    control: TenBotControl;
    onQuit(): void | Promise<void>;
}

export function TenBotTui({ control, onQuit }: TenBotTuiProps) {
    const [status, setStatus] = useState(() => control.getStatus());
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [ui, setUi] = useState<TuiState>(initialTuiState);
    const [now, setNow] = useState(() => new Date());
    const quitting = useRef(false);
    const reloadRunning = useRef(false);
    const { columns: rawColumns, rows: rawRows } = useWindowSize();
    const columns = rawColumns || 80;
    const rows = rawRows || 24;
    const visibleLogLines = Math.max(4, rows - 10);

    useEffect(() => {
        const unsubscribeStatus = control.subscribeStatus(setStatus);
        const unsubscribeLogs = control.subscribeLogs((entry) => {
            setLogs((current) => [...current, entry].slice(-MAX_TUI_LOG_ENTRIES));
            setUi((current) => current.logOffset > 0 ? { ...current, logOffset: current.logOffset + 1 } : current);
        });
        const unsubscribeEvents = control.subscribeEvents((event: RuntimeEvent) => {
            if (event.type === "provider-error") setUi((current) => receiveProviderError(current, event.notice));
        });
        return () => {
            unsubscribeStatus();
            unsubscribeLogs();
            unsubscribeEvents();
        };
    }, [control]);

    useEffect(() => {
        const timer = setInterval(() => setNow(new Date()), 1000);
        return () => clearInterval(timer);
    }, []);

    const requestQuit = () => {
        if (quitting.current) return;
        quitting.current = true;
        void onQuit();
    };

    const showReloadResult = (target: "all" | "prompt" | "memes", prompt: ReloadResult | undefined, memes: ReloadResult | undefined) => {
        const promptOk = target === "memes" ? true : Boolean(prompt?.ok);
        const memesOk = target === "prompt" ? true : Boolean(memes?.ok);
        const fresh = control.getStatus();
        setUi((current) => ({
            ...current,
            modal: {
                type: "reload-result",
                target,
                promptOk,
                memesOk,
                promptRevision: prompt?.ok ? (prompt.revision ?? fresh.prompt.revision) : undefined,
                memeRevision: memes?.ok ? (memes.revision ?? fresh.memes.revision) : undefined,
                memeCount: memes?.ok ? (memes.count ?? fresh.memes.count) : undefined,
                message: [prompt, memes].find((result) => result && !result.ok)?.message,
            },
        }));
    };

    const reload = async (target: "all" | "prompt" | "memes") => {
        if (reloadRunning.current) return;
        reloadRunning.current = true;
        try {
            if (target === "prompt") showReloadResult(target, await control.reloadPrompt(), undefined);
            else if (target === "memes") showReloadResult(target, undefined, await control.reloadMemes());
            else {
                const [prompt, memes] = await Promise.all([control.reloadPrompt(), control.reloadMemes()]);
                showReloadResult(target, prompt, memes);
            }
        } catch {
            showReloadResult(target,
                target === "memes" ? undefined : { ok: false, message: "提示词重载失败；已保留旧版本" },
                target === "prompt" ? undefined : { ok: false, message: "梗数据重载失败；已保留旧版本" });
        } finally {
            reloadRunning.current = false;
        }
    };

    useInput((input, key) => {
        const lower = input.toLowerCase();
        if (lower === "q" || (key.ctrl && lower === "c")) {
            requestQuit();
            return;
        }
        if (ui.modal.type !== "none") {
            if (key.escape) {
                if (ui.modal.type === "provider-error-details") setUi((current) => providerDetailsToSummary(current));
                else setUi(closeModal);
                return;
            }
            if (key.return) {
                if (ui.modal.type === "reload-confirm") {
                    setUi((current) => ({ ...current, modal: { type: "none" } }));
                    void reload("all");
                } else if (ui.modal.type === "provider-error-details") setUi((current) => providerDetailsToSummary(current));
                else setUi(closeModal);
                return;
            }
            if (lower === "d" && ui.modal.type === "provider-error") {
                setUi((current) => current.modal.type === "provider-error"
                    ? { ...current, modal: { type: "provider-error-details", notice: current.modal.notice, count: current.modal.count } }
                    : current);
            }
            return;
        }
        if (input === "?") {
            setUi((current) => ({ ...current, modal: { type: "help" } }));
            return;
        }
        if (lower === "p") {
            void reload("prompt");
            return;
        }
        if (lower === "m") {
            void reload("memes");
            return;
        }
        if (lower === "r") {
            setUi((current) => ({ ...current, modal: { type: "reload-confirm" } }));
            return;
        }
        if (ui.page === "logs" && ui.focus === "main") {
            if (key.pageUp) setUi((current) => ({ ...current, logOffset: clampLogOffset(current.logOffset + visibleLogLines, logs.length, visibleLogLines) }));
            else if (key.pageDown) setUi((current) => ({ ...current, logOffset: clampLogOffset(current.logOffset - visibleLogLines, logs.length, visibleLogLines) }));
            else if (key.home) setUi((current) => ({ ...current, logOffset: clampLogOffset(logs.length, logs.length, visibleLogLines) }));
            else if (key.end) setUi((current) => ({ ...current, logOffset: 0 }));
            else if (key.upArrow) setUi((current) => ({ ...current, logOffset: clampLogOffset(current.logOffset + 1, logs.length, visibleLogLines) }));
            else if (key.downArrow) setUi((current) => ({ ...current, logOffset: clampLogOffset(current.logOffset - 1, logs.length, visibleLogLines) }));
            return;
        }
        if (key.tab) {
            setUi((current) => ({ ...current, focus: current.focus === "sidebar" ? "main" : "sidebar" }));
            return;
        }
        if (key.escape) {
            setUi((current) => ({ ...current, focus: "sidebar" }));
            return;
        }
        if (ui.focus === "sidebar") {
            if (key.upArrow) setUi((current) => ({ ...current, selectedPage: movePage(current.selectedPage, -1) }));
            else if (key.downArrow) setUi((current) => ({ ...current, selectedPage: movePage(current.selectedPage, 1) }));
            else if (key.return) setUi((current) => ({ ...current, page: current.selectedPage, focus: "main" }));
        }
    });

    const content = renderView(ui.page, status, logs, ui.logOffset, visibleLogLines);
    if (columns < 60) {
        return <Box flexDirection="column" width={columns} height={rows}>
            <TopBar status={status} now={now} compact />
            <Box flexGrow={1} padding={2}><Text color="yellow">终端窗口过窄，请扩大窗口。</Text></Box>
            <Footer focus={ui.focus} />
            <ModalLayer modal={ui.modal} columns={columns} />
        </Box>;
    }
    if (rows < 12) {
        return <Box flexDirection="column" width={columns} height={rows}>
            <TopBar status={status} now={now} compact />
            <Box flexDirection="column" flexGrow={1} padding={1}>
                <Text bold>{PAGE_LABELS[ui.page]}</Text>
                <Text dimColor>窗口高度不足，已启用简化显示。</Text>
                <Text>{status.provider.model} · {status.activeCycles} 个活动周期 · {status.contextConversations} 个会话</Text>
            </Box>
            <Footer focus={ui.focus} />
            <ModalLayer modal={ui.modal} columns={columns} />
        </Box>;
    }
    return <Box flexDirection="column" width={columns} height={rows}>
        <TopBar status={status} now={now} />
        <Box flexDirection="row" flexGrow={1} minHeight={0}>
            <Sidebar selectedPage={ui.selectedPage} activePage={ui.page} focused={ui.focus === "sidebar"} />
            <Box flexDirection="column" flexGrow={1} minWidth={0} paddingX={1}>
                <Text bold color="cyan">{PAGE_LABELS[ui.page]}</Text>
                <Box flexGrow={1} minHeight={0}>{content}</Box>
            </Box>
        </Box>
        <Footer focus={ui.focus} />
        <ModalLayer modal={ui.modal} columns={columns} />
    </Box>;
}

export function StartupFailure({ message }: { message: string }) {
    return <Box flexDirection="column" paddingX={1}>
        <Text bold color="red">TenBot 启动失败</Text>
        <Text>{message}</Text>
        <Text dimColor>按 Q 或 Ctrl+C 退出。</Text>
    </Box>;
}

function movePage(page: TuiPage, delta: number): TuiPage {
    const index = Math.max(0, PAGES.indexOf(page));
    return PAGES[Math.min(PAGES.length - 1, Math.max(0, index + delta))] ?? page;
}

export function closeModal(current: TuiState): TuiState {
    if (current.queuedProviderError) {
        return {
            ...current,
            modal: { type: "provider-error", notice: current.queuedProviderError.notice, count: current.queuedProviderError.count },
            queuedProviderError: undefined,
        };
    }
    return { ...current, modal: { type: "none" } };
}

export function providerDetailsToSummary(current: TuiState): TuiState {
    if (current.modal.type !== "provider-error-details") return current;
    return { ...current, modal: { type: "provider-error", notice: current.modal.notice, count: current.modal.count } };
}

export function receiveProviderError(current: TuiState, notice: ProviderErrorNotice): TuiState {
    if (current.modal.type === "provider-error" || current.modal.type === "provider-error-details") {
        return { ...current, modal: { ...current.modal, notice, count: current.modal.count + 1 } };
    }
    if (current.modal.type === "none") return { ...current, modal: { type: "provider-error", notice, count: 1 } };
    const count = (current.queuedProviderError?.count ?? 0) + 1;
    return { ...current, queuedProviderError: { notice, count } };
}

function renderView(page: TuiPage, status: RuntimeStatus, logs: readonly LogEntry[], offset: number, visibleLines: number): React.ReactNode {
    switch (page) {
        case "overview": return <OverviewView status={status} />;
        case "model": return <ModelView status={status} />;
        case "prompt": return <PromptView status={status} />;
        case "memes": return <MemesView status={status} />;
        case "conversations": return <ConversationsView status={status} />;
        case "logs": return <LogsView logs={logs} offset={offset} visibleLines={visibleLines} />;
        case "settings": return <SettingsView status={status} />;
    }
}
