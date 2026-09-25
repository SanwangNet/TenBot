import type { ProviderErrorNotice } from "../control/provider-error.js";
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
    | { type: "provider-error-details"; notice: ProviderErrorNotice; count: number };

export interface TuiState {
    selectedPage: TuiPage;
    page: TuiPage;
    focus: TuiFocus;
    modal: ModalState;
    logOffset: number;
    settingsIndex: number;
    queuedProviderError?: { notice: ProviderErrorNotice; count: number };
}

export const initialTuiState: TuiState = {
    selectedPage: "overview",
    page: "overview",
    focus: "sidebar",
    modal: { type: "none" },
    logOffset: 0,
    settingsIndex: 0,
};

export function moveSidebarSelection(page: TuiPage, delta: number, pages: readonly TuiPage[]): TuiPage {
    const index = Math.max(0, pages.indexOf(page));
    const next = Math.min(pages.length - 1, Math.max(0, index + delta));
    return pages[next] ?? page;
}

export function moveSettingsSelection(index: number, delta: number, count = SETTINGS_FIELDS.length): number {
    return Math.min(Math.max(0, count - 1), Math.max(0, index + delta));
}

export function clampLogOffset(offset: number, total: number, visible: number): number {
    return Math.max(0, Math.min(Math.max(0, total - visible), offset));
}
