import type { ProviderErrorNotice } from "../control/provider-error.js";
import type { AutomatedPeerMutationResult, AutomatedPeerSummary } from "../control/automated-peers.js";
import type { ConfigUpdateResult, PublicConfigPatch } from "../config/config-types.js";
import type { TuiPage } from "./types.js";

export type TuiFocus = "sidebar" | "main";

export type SettingsField = PublicConfigPatch["field"];
export const SETTINGS_FIELDS: readonly SettingsField[] = [
    "aiProvider",
    "gpt.model",
    "gpt.reasoningEffort",
    "gpt.verbosity",
    "deepseek.model",
    "deepseek.reasoningEffort",
    "logLevel",
    "botLoopGuard.maxCycles",
];

export type ConfigSelectField = Exclude<SettingsField, "gpt.model" | "deepseek.model" | "botLoopGuard.maxCycles">;
export type ConfigTextField = "gpt.model" | "deepseek.model" | "botLoopGuard.maxCycles";
export interface ConfigOption {
    value: string;
    label: string;
}

export type ModalState =
    | { type: "none" }
    | { type: "help" }
    | { type: "reload-confirm" }
    | { type: "reload-result"; target: "all" | "prompt" | "memes"; promptOk: boolean; memesOk: boolean; promptRevision?: number; memeRevision?: number; memeCount?: number; message?: string }
    | { type: "config-select"; field: ConfigSelectField; title: string; options: readonly ConfigOption[]; index: number }
    | { type: "config-text"; field: ConfigTextField; title: string; value: string; cursor: number }
    | { type: "config-confirm"; patch: PublicConfigPatch; label: string; from: string; to: string }
    | { type: "config-invalid"; message: string }
    | { type: "config-result"; result: ConfigUpdateResult; label: string }
    | { type: "provider-error"; notice: ProviderErrorNotice; count: number }
    | { type: "provider-error-details"; notice: ProviderErrorNotice; count: number; scrollOffset: number }
    | { type: "quit-confirm" }
    | { type: "automated-peer-details"; peer: AutomatedPeerSummary; registered: boolean }
    | { type: "automated-peer-confirm"; action: "add" | "remove"; peer: AutomatedPeerSummary }
    | { type: "automated-peer-result"; action: "add" | "remove"; peer: AutomatedPeerSummary; result: AutomatedPeerMutationResult };

export interface TuiState {
    selectedPage: TuiPage;
    page: TuiPage;
    focus: TuiFocus;
    modal: ModalState;
    logOffset: number;
    settingsIndex: number;
    automatedPeerIndex: number;
    queuedProviderError?: { notice: ProviderErrorNotice; count: number };
}

export const initialTuiState: TuiState = {
    selectedPage: "overview",
    page: "overview",
    focus: "sidebar",
    modal: { type: "none" },
    logOffset: 0,
    settingsIndex: 0,
    automatedPeerIndex: 0,
};

export function moveSidebarSelection(page: TuiPage, delta: number, pages: readonly TuiPage[]): TuiPage {
    const index = Math.max(0, pages.indexOf(page));
    const next = Math.min(pages.length - 1, Math.max(0, index + delta));
    return pages[next] ?? page;
}

export function moveSettingsSelection(index: number, delta: number, count = SETTINGS_FIELDS.length): number {
    return Math.min(Math.max(0, count - 1), Math.max(0, index + delta));
}

export function moveAutomatedPeerSelection(index: number, delta: number, count: number): number {
    return Math.min(Math.max(0, count - 1), Math.max(0, index + delta));
}

export function toggleTuiFocus(state: TuiState): TuiState {
    return { ...state, focus: state.focus === "sidebar" ? "main" : "sidebar" };
}

export function activateSidebarPage(state: TuiState, page: TuiPage = state.selectedPage): TuiState {
    return {
        ...state,
        selectedPage: page,
        page,
        focus: "main",
        settingsIndex: page === "settings" ? 0 : state.settingsIndex,
    };
}

export function requestQuitConfirmation(state: TuiState): TuiState {
    return state.modal.type === "none" ? { ...state, modal: { type: "quit-confirm" } } : state;
}

export function quitConfirmationAction(state: TuiState, key: { return?: boolean; escape?: boolean }): "confirm" | "cancel" | undefined {
    if (state.modal.type !== "quit-confirm") return undefined;
    if (key.return) return "confirm";
    if (key.escape) return "cancel";
    return undefined;
}

export function clampLogOffset(offset: number, total: number, visible: number): number {
    return Math.max(0, Math.min(Math.max(0, total - visible), offset));
}

export interface LogNavigationKeys {
    pageUp?: boolean;
    pageDown?: boolean;
    home?: boolean;
    end?: boolean;
    upArrow?: boolean;
    downArrow?: boolean;
}

export function handleLogsNavigation(
    state: TuiState,
    key: LogNavigationKeys,
    total: number,
    visible: number,
): { state: TuiState; handled: boolean } {
    if (state.page !== "logs" || state.focus !== "main") return { state, handled: false };
    let offset: number | undefined;
    if (key.pageUp) offset = state.logOffset + visible;
    else if (key.pageDown) offset = state.logOffset - visible;
    else if (key.home) offset = total;
    else if (key.end) offset = 0;
    else if (key.upArrow) offset = state.logOffset + 1;
    else if (key.downArrow) offset = state.logOffset - 1;
    if (offset === undefined) return { state, handled: false };
    return { state: { ...state, logOffset: clampLogOffset(offset, total, visible) }, handled: true };
}
