import type { EditorResource } from "../api/types.js";

export interface EditorDraft { resource: EditorResource; content: string }
export function createEditorDraft(resource: EditorResource): EditorDraft { return { resource, content: resource.content }; }
export function editDraft(draft: EditorDraft, content: string): EditorDraft { return { ...draft, content }; }
export function isEditorDirty(draft: EditorDraft | null): boolean { return Boolean(draft && draft.content !== draft.resource.content); }
