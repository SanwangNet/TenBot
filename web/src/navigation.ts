export type PageId = "overview" | "models" | "prompts" | "memes" | "meme-library" | "conversations" | "members" | "logs" | "settings";
export type SettingsSection = "model" | "judge" | "runtime" | "image";

export interface AppRoute {
    page: PageId;
    settingsSection: SettingsSection;
}

const PAGE_IDS: readonly PageId[] = ["overview", "models", "prompts", "memes", "meme-library", "conversations", "members", "logs", "settings"];
const SETTINGS_SECTIONS: readonly SettingsSection[] = ["model", "judge", "runtime", "image"];

export function parseAppRoute(hash: string): AppRoute {
    const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
    const page = PAGE_IDS.includes(parts[0] as PageId) ? parts[0] as PageId : "overview";
    const settingsSection = page === "settings" && SETTINGS_SECTIONS.includes(parts[1] as SettingsSection)
        ? parts[1] as SettingsSection
        : "model";
    return { page, settingsSection };
}

export function appRouteHash(route: AppRoute): string {
    return route.page === "settings" ? `#/settings/${route.settingsSection}` : `#/${route.page}`;
}

export function nextPage(current: PageId, requested: PageId, editorDirty: boolean, confirmed: boolean): PageId {
    return editorDirty && !confirmed ? current : requested;
}
