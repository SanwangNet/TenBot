import type { ProviderErrorNotice } from "../control/provider-error.js";
import type { TuiPage } from "./types.js";

export type TuiFocus = "sidebar" | "main";

export type ModalState =
    | { type: "none" }
    | { type: "help" }
    | { type: "reload-confirm" }
    | { type: "reload-result"; target: "all" | "prompt" | "memes"; promptOk: boolean; memesOk: boolean; promptRevision?: number; memeRevision?: number; memeCount?: number; message?: string }
    | { type: "provider-error"; notice: ProviderErrorNotice; count: number }
    | { type: "provider-error-details"; notice: ProviderErrorNotice; count: number };

export interface TuiState {
    selectedPage: TuiPage;
    page: TuiPage;
    focus: TuiFocus;
    modal: ModalState;
    logOffset: number;
    queuedProviderError?: { notice: ProviderErrorNotice; count: number };
}

export const initialTuiState: TuiState = {
    selectedPage: "overview",
    page: "overview",
    focus: "sidebar",
    modal: { type: "none" },
    logOffset: 0,
};

export function moveSidebarSelection(page: TuiPage, delta: number, pages: readonly TuiPage[]): TuiPage {
    const index = Math.max(0, pages.indexOf(page));
    const next = Math.min(pages.length - 1, Math.max(0, index + delta));
    return pages[next] ?? page;
}

export function clampLogOffset(offset: number, total: number, visible: number): number {
    return Math.max(0, Math.min(Math.max(0, total - visible), offset));
}
