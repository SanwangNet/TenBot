import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useInput, useWindowSize } from "ink";
import type { ConfigUpdateResult, ModelProviderId, PublicConfig, PublicConfigPatch } from "../config/config-types.js";
import { cycleModelProvider, MODEL_PROVIDERS } from "../ai/model-registry.js";
import { validatePublicConfigPatch } from "../config/config-validation.js";
import type { RuntimeStatus } from "../control/runtime-status.js";
import type { ReloadResult, TenBotControl } from "../control/tenbot-control.js";
import type { ProviderErrorNotice } from "../control/provider-error.js";
import type { RuntimeEvent } from "../control/runtime-event.js";
import { parseErrorCode } from "../errors/format.js";
import type { ConversationSummary } from "../control/conversation-timeline.js";
import type { KnownMemberSummary } from "../control/known-members.js";
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
import { AutomatedPeersView } from "./views/automated-peers-view.js";
import { logLevelLabel, PAGE_LABELS, PAGES, providerLabel, reasoningLabel, settingsFieldLabel, verbosityLabel } from "./i18n.js";
import { activateSidebarPage, handleLogsNavigation, initialTuiState, moveAutomatedPeerSelection, moveSettingsSelection, quitConfirmationAction, requestQuitConfirmation, settingsRows, toggleTuiFocus, type ConfigOption, type ConfigSelectField, type ConfigTextField, type ModalState, type SettingsField, type TuiState } from "./state.js";
import type { TuiPage } from "./types.js";
import type { AutomatedPeerSummary } from "../control/automated-peers.js";
import { ClickableRegionRegistry, isSgrMouseSequence, type TerminalMouseSession } from "./mouse-input.js";
import { collapseAdjacentLogs } from "./log-collapse.js";
import { moveConversationAnchor, type ConversationScrollAnchor } from "./conversation-layout.js";
import { moveProviderErrorDetailsScroll } from "./provider-error-layout.js";

export interface TenBotTuiProps {
    control: TenBotControl;
    onQuit(): void | Promise<void>;
    mouseSession?: TerminalMouseSession;
    registerQuitRequest?(handler: () => void): () => void;
}

export function TenBotTui({ control, onQuit, mouseSession, registerQuitRequest }: TenBotTuiProps) {
    const [status, setStatus] = useState(() => control.getStatus());
    const [config, setConfig] = useState(() => control.getConfig());
    const [viewedProvider, setViewedProvider] = useState<ModelProviderId>(() => control.getConfig().aiProvider);
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const logEntriesRef = useRef<LogEntry[]>([]);
    const [ui, setUi] = useState<TuiState>(initialTuiState);
    const uiRef = useRef(ui);
    uiRef.current = ui;
    const [now, setNow] = useState(() => new Date());
    const [peerDirectory, setPeerDirectory] = useState(() => readPeerDirectory(control));
    const [knownMembers, setKnownMembers] = useState<KnownMemberSummary[]>([]);
    const [conversations, setConversations] = useState<ConversationSummary[]>(() => control.getConversations());
    const [selectedConversationId, setSelectedConversationId] = useState<string>();
    const [conversationAnchor, setConversationAnchor] = useState<ConversationScrollAnchor | null>(null);
    const [conversationViewport, setConversationViewport] = useState({ conversationId: undefined as string | undefined, viewportRows: 0, bubbleWidth: 0 });
    const quitting = useRef(false);
    const reloadRunning = useRef(false);
    const regions = useRef(new ClickableRegionRegistry()).current;
    const { columns: rawColumns, rows: rawRows } = useWindowSize();
    const columns = rawColumns || 80;
    const rows = rawRows || 24;
    const visibleLogLines = Math.max(4, rows - 10);
    const visiblePeerRows = Math.max(4, rows - 16);
    const size = useRef({ columns, rows });
    if (size.current.columns !== columns || size.current.rows !== rows) {
        regions.clear();
        size.current = { columns, rows };
    }
    regions.setModalActive(ui.modal.type !== "none");

    useEffect(() => {
        const unsubscribeStatus = control.subscribeStatus(setStatus);
        const unsubscribeLogs = control.subscribeLogs((entry) => {
            const current = logEntriesRef.current;
            const next = [...current, entry].slice(-MAX_TUI_LOG_ENTRIES);
            logEntriesRef.current = next;
            const delta = collapseAdjacentLogs(next).length - collapseAdjacentLogs(current).length;
            setLogs(next);
            setUi((state) => state.logOffset > 0 && delta > 0 ? { ...state, logOffset: state.logOffset + delta } : state);
        });
        const unsubscribeEvents = control.subscribeEvents((event: RuntimeEvent) => {
            if (event.type === "provider-error") setUi((current) => receiveProviderError(current, event.notice));
            else if (event.type === "recent-peers-updated") {
                setPeerDirectory(readPeerDirectory(control));
                if (uiRef.current.page === "automated-peers") void readKnownMembers(control).then(setKnownMembers);
            }
            else if (event.type === "conversation-item") setConversations(control.getConversations());
        });
        return () => {
            unsubscribeStatus();
            unsubscribeLogs();
            unsubscribeEvents();
        };
    }, [control]);

    useEffect(() => {
        if (ui.page === "settings") {
            const current = control.getConfig();
            setConfig(current);
            setViewedProvider(current.aiProvider);
        }
    }, [control, status.hotReload?.revision, ui.page]);

    useEffect(() => {
        if (ui.page === "automated-peers") setPeerDirectory(readPeerDirectory(control));
    }, [control, ui.page]);

    useEffect(() => {
        if (ui.page !== "automated-peers") return;
        let current = true;
        void readKnownMembers(control).then((members) => {
            if (current) setKnownMembers(members);
        });
        return () => { current = false; };
    }, [control, ui.page]);

    useEffect(() => mouseSession?.subscribe((click) => {
        if (!quitting.current) regions.dispatch(click);
    }), [mouseSession, regions]);
    useEffect(() => () => mouseSession?.leave(), [mouseSession]);

    useEffect(() => {
        const timer = setInterval(() => setNow(new Date()), 1000);
        return () => clearInterval(timer);
    }, []);

    const requestQuit = () => {
        if (quitting.current) return;
        quitting.current = true;
        void onQuit();
    };

    useEffect(() => registerQuitRequest?.(() => {
        setUi((current) => requestQuitConfirmation(current));
    }), [registerQuitRequest]);

    const refreshPeerDirectory = () => setPeerDirectory(readPeerDirectory(control));

    const allPeers = [...peerDirectory.registered, ...peerDirectory.recent];
    const requestedConversationIndex = selectedConversationId
        ? conversations.findIndex((conversation) => conversation.conversationId === selectedConversationId)
        : 0;
    const safeConversationIndex = requestedConversationIndex < 0 ? 0 : Math.min(requestedConversationIndex, Math.max(0, conversations.length - 1));
    const selectedConversation = conversations[safeConversationIndex];
    const conversationItems = selectedConversation ? control.getConversationTimeline(selectedConversation.conversationId) : [];
    useEffect(() => setConversationAnchor(null), [selectedConversation?.conversationId]);
    const updateConversationViewport = useCallback((conversationId: string | undefined, viewportRows: number, bubbleWidth: number) => {
        setConversationViewport((current) => current.conversationId === conversationId && current.viewportRows === viewportRows && current.bubbleWidth === bubbleWidth
            ? current
            : { conversationId, viewportRows, bubbleWidth });
    }, []);
    const measuredConversationViewport = conversationViewport.conversationId === selectedConversation?.conversationId
        ? conversationViewport
        : { viewportRows: 0, bubbleWidth: 0 };
    const scrollConversation = (navigation: "up" | "down" | "page-up" | "page-down" | "home" | "end") => {
        setConversationAnchor((current) => moveConversationAnchor(
            conversationItems,
            measuredConversationViewport.bubbleWidth,
            measuredConversationViewport.viewportRows,
            current,
            navigation,
        ));
    };
    const switchConversation = (delta: number) => {
        if (conversations.length < 2) return;
        const next = conversations[(safeConversationIndex + delta + conversations.length) % conversations.length];
        if (next) setSelectedConversationId(next.conversationId);
        setConversationAnchor(null);
    };
    const openPeerDetails = (index: number) => {
        const peer = allPeers[index];
        if (!peer) return;
        const registered = index < peerDirectory.registered.length;
        setUi((current) => ({ ...current, automatedPeerIndex: index, modal: { type: "automated-peer-details", peer, registered } }));
    };

    const requestPeerMutation = (action: "add" | "remove", peer: AutomatedPeerSummary) => {
        setUi((current) => ({ ...current, modal: { type: "automated-peer-confirm", action, peer } }));
    };

    const mutatePeer = async (action: "add" | "remove", peer: AutomatedPeerSummary) => {
        let result;
        try {
            result = action === "add" ? await control.addAutomatedPeer(peer.id) : await control.removeAutomatedPeer(peer.id);
        } catch {
            result = { ok: false, changed: false, message: "无法完成自动账号配置操作。", details: "配置文件操作失败" };
        }
        refreshPeerDirectory();
        setUi((current) => ({ ...current, modal: { type: "automated-peer-result", action, peer, result } }));
    };

    const editSetting = (field: SettingsField) => setUi((current) => ({
        ...current,
        settingsIndex: settingsRowIndex(field, viewedProvider),
        modal: openConfigModal(field, config),
    }));

    const viewProvider = (delta: number) => {
        setViewedProvider(cycleModelProvider(viewedProvider, delta));
        setUi((current) => ({ ...current, settingsIndex: 0 }));
    };

    const applyViewedProvider = () => {
        const patch: PublicConfigPatch = { field: "aiProvider", value: viewedProvider };
        setUi((current) => ({ ...current, settingsIndex: settingsRows(viewedProvider).indexOf("apply"), modal: {
            type: "config-confirm", patch, label: "模型提供商", from: providerLabel(config.aiProvider), to: providerLabel(viewedProvider),
        } }));
    };

    const advanceConfigText = () => {
        if (ui.modal.type !== "config-text") return;
        const current = ui.modal;
        const patch = textPatch(current.field, current.value);
        if (patch.error) setUi((state) => ({ ...state, modal: { type: "config-invalid", message: patch.error } }));
        else if (patch.value) setUi((state) => ({ ...state, modal: { type: "config-confirm", patch: patch.value, label: settingsFieldLabel(current.field), from: configValue(config, current.field), to: displayPatchValue(patch.value) } }));
    };

    const confirmModal = () => {
        const modal = ui.modal;
        if (modal.type === "quit-confirm") { requestQuit(); return; }
        if (modal.type === "reload-confirm") {
            setUi((current) => ({ ...current, modal: { type: "none" } }));
            void reload("all");
            return;
        }
        if (modal.type === "config-text") { advanceConfigText(); return; }
        if (modal.type === "config-select") {
            const option = modal.options[modal.index];
            if (!option) return;
            const patch = optionPatch(modal.field, option.value);
            setUi((state) => ({ ...state, modal: { type: "config-confirm", patch, label: settingsFieldLabel(modal.field), from: configValue(config, modal.field), to: displayPatchValue(patch) } }));
            return;
        }
        if (modal.type === "config-confirm") { void saveConfig(modal.patch, modal.label); return; }
        if (modal.type === "automated-peer-confirm") { void mutatePeer(modal.action, modal.peer); return; }
        if (modal.type === "provider-error-details") { setUi((current) => providerDetailsToSummary(current)); return; }
        setUi(closeModal);
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

    const saveConfig = async (patch: PublicConfigPatch, label: string) => {
        let result: ConfigUpdateResult;
        try {
            result = await control.updateConfig(patch);
        } catch {
            result = { ok: false, requiresRestart: false, changedFields: [], message: "配置保存失败", details: "无法完成配置操作" };
        }
        setConfig(control.getConfig());
        setUi((current) => ({ ...current, modal: { type: "config-result", result, label } }));
    };

    useInput((input, key) => {
        if (quitting.current) return;
        if (mouseSession?.handleInput(input)) return;
        if (isSgrMouseSequence(input)) return;
        const lower = input.toLowerCase();
        if (ui.modal.type === "config-text") {
            if (key.escape) {
                setUi(closeModal);
                return;
            }
            if (key.return) {
                advanceConfigText();
                return;
            }
            if (key.backspace || input === "\b") {
                if (ui.modal.cursor > 0) setUi((state) => state.modal.type === "config-text"
                    ? { ...state, modal: { ...state.modal, value: state.modal.value.slice(0, state.modal.cursor - 1) + state.modal.value.slice(state.modal.cursor), cursor: state.modal.cursor - 1 } }
                    : state);
                return;
            }
            if (key.delete) {
                setUi((state) => state.modal.type === "config-text"
                    ? { ...state, modal: { ...state.modal, value: state.modal.value.slice(0, state.modal.cursor) + state.modal.value.slice(state.modal.cursor + 1) } }
                    : state);
                return;
            }
            if (key.leftArrow) {
                setUi((state) => state.modal.type === "config-text" ? { ...state, modal: { ...state.modal, cursor: Math.max(0, state.modal.cursor - 1) } } : state);
                return;
            }
            if (key.rightArrow) {
                setUi((state) => state.modal.type === "config-text" ? { ...state, modal: { ...state.modal, cursor: Math.min(state.modal.value.length, state.modal.cursor + 1) } } : state);
                return;
            }
            if (key.home || (key.ctrl && lower === "a")) {
                setUi((state) => state.modal.type === "config-text" ? { ...state, modal: { ...state.modal, cursor: 0 } } : state);
                return;
            }
            if (key.end) {
                setUi((state) => state.modal.type === "config-text" ? { ...state, modal: { ...state.modal, cursor: state.modal.value.length } } : state);
                return;
            }
            if (input && !key.ctrl && !key.meta && !/[\r\n]/.test(input)) {
                setUi((state) => state.modal.type === "config-text"
                    ? { ...state, modal: { ...state.modal, value: state.modal.value.slice(0, state.modal.cursor) + input + state.modal.value.slice(state.modal.cursor), cursor: state.modal.cursor + input.length } }
                    : state);
            }
            return;
        }
        if (ui.modal.type !== "none") {
            if (key.escape) {
                if (ui.modal.type === "provider-error-details") setUi((current) => providerDetailsToSummary(current));
                else setUi(closeModal);
                return;
            }
            if (ui.modal.type === "provider-error-details") {
                const navigation = key.upArrow ? "up" : key.downArrow ? "down"
                    : key.pageUp ? "page-up" : key.pageDown ? "page-down"
                        : key.home ? "home" : key.end ? "end" : undefined;
                if (navigation) setUi((current) => current.modal.type === "provider-error-details"
                    ? { ...current, modal: { ...current.modal, scrollOffset: moveProviderErrorDetailsScroll(
                        current.modal.notice, current.modal.count, columns, rows, current.modal.scrollOffset, navigation,
                    ) } }
                    : current);
                else if (key.return) setUi((current) => providerDetailsToSummary(current));
                return;
            }
            if (ui.modal.type === "config-select") {
                if (key.upArrow || key.downArrow) {
                    const delta = key.downArrow ? 1 : -1;
                    setUi((current) => current.modal.type === "config-select"
                        ? { ...current, modal: { ...current.modal, index: Math.min(current.modal.options.length - 1, Math.max(0, current.modal.index + delta)) } }
                        : current);
                } else if (key.return) confirmModal();
                return;
            }
            if (ui.modal.type === "config-confirm") {
                if (key.return) confirmModal();
                return;
            }
            if (ui.modal.type === "quit-confirm") {
                const action = quitConfirmationAction(ui, key);
                if (action === "confirm") confirmModal();
                else if (action === "cancel") setUi(closeModal);
                return;
            }
            if (ui.modal.type === "automated-peer-confirm") {
                if (key.return) confirmModal();
                return;
            }
            if (ui.modal.type === "automated-peer-details") {
                if (lower === "a" && !ui.modal.registered) requestPeerMutation("add", ui.modal.peer);
                else if ((key.delete || input === "\u007f") && ui.modal.registered) requestPeerMutation("remove", ui.modal.peer);
                return;
            }
            if (key.return) {
                confirmModal();
                return;
            }
            if (lower === "d" && ui.modal.type === "provider-error") {
                setUi((current) => current.modal.type === "provider-error"
                    ? { ...current, modal: { type: "provider-error-details", notice: current.modal.notice, count: current.modal.count, scrollOffset: 0 } }
                    : current);
            }
            return;
        }
        if (lower === "q" || (key.ctrl && lower === "c")) {
            setUi((current) => requestQuitConfirmation(current));
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
        if (key.tab) {
            setUi((current) => toggleTuiFocus(current));
            return;
        }
        if (key.escape) {
            setUi((current) => ({ ...current, focus: "sidebar" }));
            return;
        }
        if (ui.page === "logs" && ui.focus === "main") {
            const navigation = handleLogsNavigation(ui, key, collapseAdjacentLogs(logs).length, visibleLogLines);
            if (navigation.handled) {
                setUi(navigation.state);
                return;
            }
        }
        if (ui.page === "conversations" && ui.focus === "main") {
            if (key.leftArrow) switchConversation(-1);
            else if (key.rightArrow) switchConversation(1);
            else if (key.upArrow) scrollConversation("up");
            else if (key.downArrow) scrollConversation("down");
            else if (key.pageUp) scrollConversation("page-up");
            else if (key.pageDown) scrollConversation("page-down");
            else if (key.home) scrollConversation("home");
            else if (key.end) scrollConversation("end");
            return;
        }
        if (ui.page === "settings" && ui.focus === "main") {
            const rowCount = settingsRows(viewedProvider).length;
            if (ui.settingsIndex === 0 && key.leftArrow) viewProvider(-1);
            else if (ui.settingsIndex === 0 && key.rightArrow) viewProvider(1);
            else if (key.upArrow) setUi((current) => ({ ...current, settingsIndex: moveSettingsSelection(current.settingsIndex, -1, rowCount) }));
            else if (key.downArrow) setUi((current) => ({ ...current, settingsIndex: moveSettingsSelection(current.settingsIndex, 1, rowCount) }));
            else if (key.return) {
                const row = settingsRows(viewedProvider)[ui.settingsIndex];
                if (row === "apply") applyViewedProvider();
                else if (row && row !== "provider") editSetting(row);
            }
            return;
        }
        if (ui.page === "automated-peers" && ui.focus === "main") {
            if (key.upArrow) setUi((current) => ({ ...current, automatedPeerIndex: moveAutomatedPeerSelection(current.automatedPeerIndex, -1, allPeers.length) }));
            else if (key.downArrow) setUi((current) => ({ ...current, automatedPeerIndex: moveAutomatedPeerSelection(current.automatedPeerIndex, 1, allPeers.length) }));
            else if (key.return) openPeerDetails(ui.automatedPeerIndex);
            else if (lower === "a") {
                const peer = allPeers[ui.automatedPeerIndex];
                if (peer && ui.automatedPeerIndex >= peerDirectory.registered.length) requestPeerMutation("add", peer);
            } else if (key.delete || input === "\u007f") {
                const peer = peerDirectory.registered[ui.automatedPeerIndex];
                if (peer) requestPeerMutation("remove", peer);
            }
            return;
        }
        if (ui.focus === "sidebar") {
            if (key.upArrow) setUi((current) => ({ ...current, selectedPage: movePage(current.selectedPage, -1) }));
            else if (key.downArrow) setUi((current) => ({ ...current, selectedPage: movePage(current.selectedPage, 1) }));
            else if (key.return) setUi((current) => activateSidebarPage(current));
        }
    });

    const showPendingRestart = hasPendingRestart(status, config);
    const content = renderView(
        ui.page, status, config, logs, ui.logOffset, visibleLogLines, ui.settingsIndex, showPendingRestart,
        peerDirectory, knownMembers, ui.automatedPeerIndex, visiblePeerRows, Math.max(1, columns - 22), regions, editSetting, openPeerDetails,
        conversations, safeConversationIndex, conversationItems, conversationAnchor, updateConversationViewport, switchConversation,
        viewedProvider, viewProvider, applyViewedProvider,
    );
    const closeCurrentModal = () => setUi(closeModal);
    const selectModalOption = (index: number) => setUi((current) => current.modal.type === "config-select"
        ? { ...current, modal: { ...current.modal, index } }
        : current);
    const openProviderDetails = () => setUi((current) => current.modal.type === "provider-error"
        ? { ...current, modal: { type: "provider-error-details", notice: current.modal.notice, count: current.modal.count, scrollOffset: 0 } }
        : current);
    const modalProps = {
        modal: ui.modal,
        columns,
        rows,
        registry: regions,
        onClose: closeCurrentModal,
        onConfirm: confirmModal,
        onOption: selectModalOption,
        onProviderDetails: openProviderDetails,
        onAddPeer: (peer: AutomatedPeerSummary) => requestPeerMutation("add", peer),
        onRemovePeer: (peer: AutomatedPeerSummary) => requestPeerMutation("remove", peer),
        maxCycles: status.runtimeConfig?.botLoopGuardMaxCycles ?? 4,
    };
    const footerProps = {
        focus: ui.focus,
        settings: ui.page === "settings" && ui.focus === "main",
        automatedPeers: ui.page === "automated-peers" && ui.focus === "main",
        conversations: ui.page === "conversations" && ui.focus === "main",
        logs: ui.page === "logs" && ui.focus === "main",
        notice: status.hotReload?.lastFailure?.message,
    };
    const selectSidebarPage = (page: TuiPage) => setUi((current) => activateSidebarPage(current, page));
    if (columns < 60) {
        return <Box flexDirection="column" width={columns} height={rows}>
            <TopBar status={status} now={now} compact />
            <Box flexGrow={1} padding={2}><Text color="yellow">终端窗口过窄，请扩大窗口。</Text></Box>
            <Footer {...footerProps} />
            <ModalLayer {...modalProps} />
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
            <Footer {...footerProps} />
            <ModalLayer {...modalProps} />
        </Box>;
    }
    return <Box flexDirection="column" width={columns} height={rows}>
        <TopBar status={status} now={now} />
        <Box flexDirection="row" flexGrow={1} minHeight={0}>
            <Sidebar selectedPage={ui.selectedPage} activePage={ui.page} focused={ui.focus === "sidebar"} registry={regions} onSelectPage={selectSidebarPage} />
            <Box flexDirection="column" flexGrow={1} minWidth={0} paddingX={1}>
                <Text bold color="cyan">{PAGE_LABELS[ui.page]}</Text>
                <Box flexGrow={1} minHeight={0}>{content}</Box>
            </Box>
        </Box>
        <Footer {...footerProps} />
        <ModalLayer {...modalProps} />
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
    if (parseErrorCode(notice.tenbotCode)?.class === "C") return current;
    if (current.modal.type === "provider-error" || current.modal.type === "provider-error-details") {
        return { ...current, modal: { ...current.modal, notice, count: current.modal.count + 1 } };
    }
    if (current.modal.type === "none") return { ...current, modal: { type: "provider-error", notice, count: 1 } };
    const count = (current.queuedProviderError?.count ?? 0) + 1;
    return { ...current, queuedProviderError: { notice, count } };
}

function renderView(
    page: TuiPage,
    status: RuntimeStatus,
    config: PublicConfig,
    logs: readonly LogEntry[],
    offset: number,
    visibleLines: number,
    settingsIndex: number,
    pendingRestart: boolean,
    peerDirectory: { registered: AutomatedPeerSummary[]; recent: AutomatedPeerSummary[] },
    knownMembers: readonly KnownMemberSummary[],
    automatedPeerIndex: number,
    visiblePeerRows: number,
    contentWidth: number,
    regions: ClickableRegionRegistry,
    onEditSetting: (field: SettingsField) => void,
    onOpenPeer: (index: number) => void,
    conversations: readonly ConversationSummary[],
    conversationIndex: number,
    conversationItems: ReturnType<TenBotControl["getConversationTimeline"]>,
    conversationAnchor: ConversationScrollAnchor | null,
    onViewportMeasure: (conversationId: string | undefined, viewportRows: number, bubbleWidth: number) => void,
    onSwitchConversation: (delta: number) => void,
    viewedProvider: ModelProviderId,
    onViewProvider: (delta: number) => void,
    onApplyProvider: () => void,
): React.ReactNode {
    switch (page) {
        case "overview": return <OverviewView status={status} />;
        case "model": return <ModelView status={status} />;
        case "prompt": return <PromptView status={status} />;
        case "memes": return <MemesView status={status} />;
        case "conversations": return <ConversationsView conversations={conversations} selectedIndex={conversationIndex} items={conversationItems} anchor={conversationAnchor} registry={regions} onSwitch={onSwitchConversation} onViewportMeasure={onViewportMeasure} />;
        case "logs": return <LogsView logs={logs} offset={offset} visibleLines={visibleLines} />;
        case "settings": return <SettingsView status={status} config={config} selectedIndex={settingsIndex} pendingRestart={pendingRestart} viewedProvider={viewedProvider} width={contentWidth} registry={regions} onEdit={onEditSetting} onViewProvider={onViewProvider} onApplyProvider={onApplyProvider} />;
        case "automated-peers": return <AutomatedPeersView registered={peerDirectory.registered} recent={peerDirectory.recent} knownMembers={knownMembers} selectedIndex={automatedPeerIndex} visibleCount={visiblePeerRows} width={contentWidth} registry={regions} onOpen={onOpenPeer} />;
    }
}

function readPeerDirectory(control: TenBotControl): { registered: AutomatedPeerSummary[]; recent: AutomatedPeerSummary[] } {
    try {
        return { registered: control.getAutomatedPeers(), recent: control.getRecentPeers() };
    } catch {
        return { registered: [], recent: [] };
    }
}

export async function readKnownMembers(control: TenBotControl): Promise<KnownMemberSummary[]> {
    try { return await control.getKnownMembers(); }
    catch { return []; }
}

const reasoningOptions: readonly ConfigOption[] = [
    { value: "none", label: "关闭" },
    { value: "low", label: "低" },
    { value: "medium", label: "中" },
    { value: "high", label: "高" },
    { value: "xhigh", label: "极高" },
];
const verbosityOptions: readonly ConfigOption[] = [
    { value: "low", label: "简洁" },
    { value: "medium", label: "标准" },
    { value: "high", label: "详细" },
];
const providerOptions: readonly ConfigOption[] = MODEL_PROVIDERS.map(({ id, label }) => ({ value: id, label }));
const logLevelOptions: readonly ConfigOption[] = [
    { value: "debug", label: "调试" },
    { value: "info", label: "信息" },
    { value: "error", label: "错误" },
];

function settingsRowIndex(field: SettingsField, provider: ModelProviderId): number {
    return settingsRows(provider).indexOf(field);
}

function configValue(config: PublicConfig, field: SettingsField): string {
    switch (field) {
        case "aiProvider": return providerLabel(config.aiProvider);
        case "gpt.model": return config.gpt.model;
        case "gpt.reasoningEffort": return reasoningLabel(config.gpt.reasoningEffort);
        case "gpt.verbosity": return verbosityLabel(config.gpt.verbosity);
        case "deepseek.model": return config.deepseek.model;
        case "deepseek.reasoningEffort": return reasoningLabel(config.deepseek.reasoningEffort);
        case "replyJudge.model": return config.replyJudge.model;
        case "replyJudge.timeoutMs": return String(config.replyJudge.timeoutMs);
        case "replyJudge.fallbackToMainOnInvalidOutput": return config.replyJudge.fallbackToMainOnInvalidOutput ? "开启" : "关闭";
        case "replyJudge.turnWaitMs": return String(config.replyJudge.turnWaitMs);
        case "logLevel": return logLevelLabel(config.logLevel);
        case "botLoopGuard.maxCycles": return String(config.botLoopGuard.maxCycles);
    }
}

function displayPatchValue(patch: PublicConfigPatch): string {
    switch (patch.field) {
        case "aiProvider": return providerLabel(patch.value);
        case "gpt.reasoningEffort":
        case "deepseek.reasoningEffort": return reasoningLabel(patch.value);
        case "gpt.verbosity": return verbosityLabel(patch.value);
        case "logLevel": return logLevelLabel(patch.value);
        case "replyJudge.fallbackToMainOnInvalidOutput": return patch.value ? "开启" : "关闭";
        default: return String(patch.value);
    }
}

function optionPatch(field: ConfigSelectField, value: string): PublicConfigPatch {
    switch (field) {
        case "aiProvider": return { field, value: value as "gpt" | "deepseek" };
        case "gpt.reasoningEffort": return { field, value: value as "none" | "low" | "medium" | "high" | "xhigh" };
        case "gpt.verbosity": return { field, value: value as "low" | "medium" | "high" };
        case "deepseek.reasoningEffort": return { field, value: value as "none" | "low" | "medium" | "high" | "xhigh" };
        case "logLevel": return { field, value: value as "debug" | "info" | "error" };
    }
}

export function textPatch(field: ConfigTextField, value: string): { value: PublicConfigPatch; error?: undefined } | { value?: undefined; error: string } {
    if (field === "botLoopGuard.maxCycles" && !/^\d+$/.test(value.trim())) {
        return { error: "自动账号连续交互上限必须是大于等于 1 的整数" };
    }
    if (field === "replyJudge.timeoutMs" && !/^\d+$/.test(value.trim())) {
        return { error: "Reply Judge 超时时间必须是 1000 到 30000 毫秒之间的整数" };
    }
    const patch: PublicConfigPatch = field === "gpt.model"
        ? { field, value }
        : field === "deepseek.model"
            ? { field, value }
            : field === "replyJudge.model"
                ? { field, value }
                : { field, value: Number(value.trim()) };
    try {
        validatePublicConfigPatch(patch);
        return { value: patch };
    } catch (error) {
        return { error: error instanceof Error ? error.message : "配置值不符合要求" };
    }
}

export function openConfigModal(field: SettingsField, config: PublicConfig): ModalState {
    if (field === "aiProvider") return selectConfigModal(field, providerOptions, config.aiProvider);
    if (field === "gpt.reasoningEffort") return selectConfigModal(field, reasoningOptions, config.gpt.reasoningEffort);
    if (field === "deepseek.reasoningEffort") return selectConfigModal(field, reasoningOptions, config.deepseek.reasoningEffort);
    if (field === "gpt.verbosity") return selectConfigModal(field, verbosityOptions, config.gpt.verbosity);
    if (field === "logLevel") return selectConfigModal(field, logLevelOptions, config.logLevel);
    if (field === "gpt.model") return textConfigModal(field, config.gpt.model);
    if (field === "deepseek.model") return textConfigModal(field, config.deepseek.model);
    if (field === "replyJudge.model") return textConfigModal(field, config.replyJudge.model);
    if (field === "replyJudge.timeoutMs") return textConfigModal(field, String(config.replyJudge.timeoutMs));
    if (field === "replyJudge.fallbackToMainOnInvalidOutput") return { type: "config-invalid", message: "Use Web Settings to manage Judge IPO fallback" };
    if (field === "replyJudge.turnWaitMs") return { type: "config-invalid", message: "Use Web Settings to manage Judge turn wait" };
    return textConfigModal(field, String(config.botLoopGuard.maxCycles));
}

function selectConfigModal(field: ConfigSelectField, options: readonly ConfigOption[], rawValue: string): ModalState {
    const index = Math.max(0, options.findIndex((option) => option.value === rawValue));
    return { type: "config-select", field, title: `选择${settingsFieldLabel(field)}`, options, index };
}

function textConfigModal(field: ConfigTextField, value: string): ModalState {
    return { type: "config-text", field, title: `修改${settingsFieldLabel(field)}`, value, cursor: value.length };
}

export function hasPendingRestart(status: RuntimeStatus, config: PublicConfig): boolean {
    void config;
    return status.hotReload?.requiresRestart ?? false;
}
