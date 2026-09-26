import type { ProviderErrorNotice } from "../api/types.js";

export type NoticeTone = "success" | "warning" | "error" | "info";
export interface Notice { id: number; tone: NoticeTone; message: string; count: number; details?: ProviderErrorNotice }

export function addNotice(current: readonly Notice[], next: Notice): Notice[] {
    const duplicate = next.details && current.find((item) => item.details && item.details.tenbotCode === next.details?.tenbotCode && item.details.message === next.details.message);
    if (duplicate) return current.map((item) => item.id === duplicate.id ? { ...item, count: item.count + 1, details: next.details } : item);
    return [...current, next].slice(-5);
}

export function isProminentProviderError(notice: ProviderErrorNotice): boolean {
    return !/^[^:]+:C_/.test(notice.tenbotCode);
}
