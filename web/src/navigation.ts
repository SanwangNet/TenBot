export type PageId = "overview" | "models" | "prompts" | "memes" | "conversations" | "peers" | "logs" | "settings";

export function nextPage(current: PageId, requested: PageId, editorDirty: boolean, confirmed: boolean): PageId {
    return editorDirty && !confirmed ? current : requested;
}
