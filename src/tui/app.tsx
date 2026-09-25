import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput, useWindowSize } from "ink";
import type { ConfigUpdateResult, PublicConfig, PublicConfigPatch } from "../config/config-types.js";
import { validatePublicConfigPatch } from "../config/config-validation.js";
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
import { logLevelLabel, PAGE_LABELS, PAGES, providerLabel, reasoningLabel, settingsFieldLabel, verbosityLabel } from "./i18n.js";
import { clampLogOffset, initialTuiState, moveSettingsSelection, SETTINGS_FIELDS, type ConfigOption, type ConfigSelectField, type ConfigTextField, type ModalState, type SettingsField, type TuiState } from "./state.js";
import type { TuiPage } from "./types.js";

export interface TenBotTuiProps {
    control: TenBotControl;
    onQuit(): void | Promise<void>;
}

export function TenBotTui({ control, onQuit }: TenBotTuiProps) {
    const [status, setStatus] = useState(() => control.getStatus());
    const [config, setConfig] = useState(() => control.getConfig());
    const [pendingRestart, setPendingRestart] = useState(false);
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
        if (ui.page === "settings") setConfig(control.getConfig());
    }, [control, ui.page]);

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

    const saveConfig = async (patch: PublicConfigPatch, label: string) => {
        let result: ConfigUpdateResult;
        try {
            result = await control.updateConfig(patch);
        } catch {
            result = { ok: false, requiresRestart: false, changedFields: [], message: "配置保存失败", details: "无法完成配置操作" };
        }
        setConfig(control.getConfig());
        if (result.ok && result.requiresRestart) setPendingRestart(true);
        setUi((current) => ({ ...current, modal: { type: "config-result", result, label } }));
    };

    useInput((input, key) => {
        const lower = input.toLowerCase();
        if (ui.modal.type === "config-text") {
            if (key.escape) {
                setUi(closeModal);
                return;
            }
            if (key.return) {
                const current = ui.modal;
                const patch = textPatch(current.field, current.value);
                if (patch.error) setUi((state) => ({ ...state, modal: { type: "config-invalid", message: patch.error } }));
                else if (patch.value) setUi((state) => ({ ...state, modal: { type: "config-confirm", patch: patch.value, label: settingsFieldLabel(current.field), from: configValue(config, current.field), to: displayPatchValue(patch.value) } }));
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
            if (ui.modal.type === "config-select") {
                if (key.upArrow || key.downArrow) {
                    const delta = key.downArrow ? 1 : -1;
                    setUi((current) => current.modal.type === "config-select"
                        ? { ...current, modal: { ...current.modal, index: Math.min(current.modal.options.length - 1, Math.max(0, current.modal.index + delta)) } }
                        : current);
                } else if (key.return) {
                    const current = ui.modal;
                    const option = current.options[current.index];
                    if (!option) return;
                    const patch = optionPatch(current.field, option.value);
                    setUi((state) => ({ ...state, modal: { type: "config-confirm", patch, label: settingsFieldLabel(current.field), from: configValue(config, current.field), to: displayPatchValue(patch) } }));
                }
                return;
            }
            if (ui.modal.type === "config-confirm") {
                if (key.return) {
                    const current = ui.modal;
                    void saveConfig(current.patch, current.label);
                }
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
        if (lower === "q" || (key.ctrl && lower === "c")) {
            requestQuit();
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
        if (ui.page === "settings" && ui.focus === "main") {
            if (key.upArrow) setUi((current) => ({ ...current, settingsIndex: moveSettingsSelection(current.settingsIndex, -1) }));
            else if (key.downArrow) setUi((current) => ({ ...current, settingsIndex: moveSettingsSelection(current.settingsIndex, 1) }));
            else if (key.return) setUi((current) => ({ ...current, modal: openConfigModal(SETTINGS_FIELDS[current.settingsIndex] ?? SETTINGS_FIELDS[0], config) }));
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
            else if (key.return) setUi((current) => ({ ...current, page: current.selectedPage, focus: "main", settingsIndex: current.selectedPage === "settings" ? 0 : current.settingsIndex }));
        }
    });

    const showPendingRestart = pendingRestart || hasPendingRestart(status, config);
    const content = renderView(ui.page, status, config, logs, ui.logOffset, visibleLogLines, ui.settingsIndex, showPendingRestart);
    if (columns < 60) {
        return <Box flexDirection="column" width={columns} height={rows}>
            <TopBar status={status} now={now} compact />
            <Box flexGrow={1} padding={2}><Text color="yellow">终端窗口过窄，请扩大窗口。</Text></Box>
            <Footer focus={ui.focus} settings={ui.page === "settings" && ui.focus === "main"} />
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
            <Footer focus={ui.focus} settings={ui.page === "settings" && ui.focus === "main"} />
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
        <Footer focus={ui.focus} settings={ui.page === "settings" && ui.focus === "main"} />
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

function renderView(page: TuiPage, status: RuntimeStatus, config: PublicConfig, logs: readonly LogEntry[], offset: number, visibleLines: number, settingsIndex: number, pendingRestart: boolean): React.ReactNode {
    switch (page) {
        case "overview": return <OverviewView status={status} />;
        case "model": return <ModelView status={status} />;
        case "prompt": return <PromptView status={status} />;
        case "memes": return <MemesView status={status} />;
        case "conversations": return <ConversationsView status={status} />;
        case "logs": return <LogsView logs={logs} offset={offset} visibleLines={visibleLines} />;
        case "settings": return <SettingsView status={status} config={config} selectedIndex={settingsIndex} pendingRestart={pendingRestart} />;
    }
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
const providerOptions: readonly ConfigOption[] = [
    { value: "gpt", label: "GPT" },
    { value: "deepseek", label: "DeepSeek" },
];
const logLevelOptions: readonly ConfigOption[] = [
    { value: "debug", label: "调试" },
    { value: "info", label: "信息" },
    { value: "error", label: "错误" },
];

function configValue(config: PublicConfig, field: SettingsField): string {
    switch (field) {
        case "aiProvider": return providerLabel(config.aiProvider);
        case "gpt.model": return config.gpt.model;
        case "gpt.reasoningEffort": return reasoningLabel(config.gpt.reasoningEffort);
        case "gpt.verbosity": return verbosityLabel(config.gpt.verbosity);
        case "deepseek.model": return config.deepseek.model;
        case "deepseek.reasoningEffort": return reasoningLabel(config.deepseek.reasoningEffort);
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
    const patch: PublicConfigPatch = field === "gpt.model"
        ? { field, value }
        : field === "deepseek.model"
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
    if (status.provider.id !== config.aiProvider) return true;
    const active = status.provider.id === "gpt" ? config.gpt : config.deepseek;
    if (status.provider.model !== active.model) return true;
    if (status.provider.reasoningEffort !== active.reasoningEffort) return true;
    if (status.provider.id === "gpt" && status.provider.verbosity !== config.gpt.verbosity) return true;
    if (status.runtimeConfig && (status.runtimeConfig.logLevel !== config.logLevel || status.runtimeConfig.botLoopGuardMaxCycles !== config.botLoopGuard.maxCycles)) return true;
    return false;
}
