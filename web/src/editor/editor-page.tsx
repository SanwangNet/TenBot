import { useEffect, useRef, useState } from "react";
import Editor, { loader } from "@monaco-editor/react";
import * as monaco from "../../../node_modules/monaco-editor/esm/vs/editor/editor.api.js";
import "../../../node_modules/monaco-editor/esm/vs/languages/definitions/markdown/register.js";
import "../../../node_modules/monaco-editor/esm/vs/language/json/monaco.contribution.js";
import EditorWorker from "../../../node_modules/monaco-editor/esm/vs/editor/editor.worker.js?worker";
import JsonWorker from "../../../node_modules/monaco-editor/esm/vs/language/json/json.worker.js?worker";
import { apiClient, ApiError } from "../api/client.js";
import type { EditorResourceId } from "../api/types.js";
import { useFeedback } from "../ui/feedback.js";
import { useRuntime } from "../runtime/runtime-context.js";
import { createEditorDraft, editDraft, isEditorDirty, type EditorDraft } from "./editor-state.js";

self.MonacoEnvironment = { getWorker(_moduleId, label) { return label === "json" ? new JsonWorker() : new EditorWorker(); } };
loader.config({ monaco });

const promptTabs: Array<{ id: EditorResourceId; label: string }> = [
    { id: "prompt:gpt", label: "GPT" }, { id: "prompt:deepseek", label: "DeepSeek" }, { id: "prompt:reply-judge", label: "Reply Judge" },
];

export function EditorPage({ mode, onDirtyChange }: { mode: "prompts" | "memes"; onDirtyChange(dirty: boolean): void }) {
    const [resourceId, setResourceId] = useState<EditorResourceId>(mode === "prompts" ? "prompt:gpt" : "meme:data");
    const [draft, setDraft] = useState<EditorDraft | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const { status } = useRuntime();
    const { confirm, notify } = useFeedback();
    const dirty = isEditorDirty(draft);
    const saveRef = useRef<() => void>(() => undefined);

    useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
    useEffect(() => {
        const controller = new AbortController();
        setLoading(true); setError(null); setDraft(null);
        void apiClient.getEditorResource(resourceId, controller.signal).then((resource) => { setDraft(createEditorDraft(resource)); setLoading(false); })
            .catch(() => { if (!controller.signal.aborted) { setError("无法读取编辑资源"); setLoading(false); } });
        return () => controller.abort();
    }, [resourceId]);
    useEffect(() => {
        const listener = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ""; } };
        window.addEventListener("beforeunload", listener);
        return () => window.removeEventListener("beforeunload", listener);
    }, [dirty]);
    useEffect(() => {
        const listener = (event: KeyboardEvent) => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
                event.preventDefault(); event.stopPropagation(); saveRef.current();
            }
        };
        window.addEventListener("keydown", listener, true);
        return () => window.removeEventListener("keydown", listener, true);
    }, []);

    async function save() {
        if (!draft || !dirty || saving) return;
        setSaving(true); setError(null);
        try {
            const result = await apiClient.saveEditorResource(draft.resource.id, draft.content, draft.resource.version);
            setDraft(createEditorDraft(result.resource));
            if (result.reload.ok) notify("success", `${result.resource.displayName} 已保存并热重载`);
            else notify("warning", "文件已保存，但 Runtime reload 失败；当前继续使用上一份有效快照。");
        } catch (cause) {
            if (cause instanceof ApiError && cause.status === 409) {
                const reload = await confirm({ title: "文件版本冲突", message: "文件已在服务器端发生变化。重新载入会放弃当前编辑内容；取消可保留草稿。", confirmLabel: "重新载入", danger: true });
                if (reload) await loadResource(draft.resource.id);
            } else {
                const message = cause instanceof ApiError ? cause.message : "保存失败";
                setError(message); notify("error", message);
            }
        } finally { setSaving(false); }
    }
    saveRef.current = () => { void save(); };

    async function loadResource(id: EditorResourceId) {
        setLoading(true);
        try { setDraft(createEditorDraft(await apiClient.getEditorResource(id))); setError(null); }
        catch { setError("无法重新载入编辑资源"); }
        finally { setLoading(false); }
    }
    async function chooseTab(id: EditorResourceId) {
        if (id === resourceId) return;
        if (dirty && !await confirm({ title: "放弃未保存更改？", message: "切换文件会丢弃当前编辑内容。", confirmLabel: "放弃更改", danger: true })) return;
        setResourceId(id);
    }
    function formatJson() {
        if (!draft) return;
        try { setDraft(editDraft(draft, `${JSON.stringify(JSON.parse(draft.content), null, 2)}\n`)); setError(null); }
        catch { setError("JSON 格式不正确，无法格式化"); }
    }
    return <section className="editor-page">
        <div className="page-heading"><div><div className="eyebrow">CONTROL PLANE / EDITOR</div><h1>{mode === "prompts" ? "提示词" : "梗数据"}</h1><p>{mode === "prompts" ? "编辑 Runtime 使用的 Prompt 文件。" : "编辑 Meme 知识库 JSON，保存前由服务器验证。"}</p></div>
            <span className="editor-status">{dirty ? "● 未保存" : loading ? "载入中" : "✓ 已同步"}</span></div>
        {mode === "memes" && <div className="editor-metrics"><span>条目 <strong>{status?.memes.count ?? "—"}</strong></span><span>Revision <strong>r{status?.memes.revision ?? "—"}</strong></span><span>Loaded At <strong>{status?.memes.loadedAt ? new Date(status.memes.loadedAt).toLocaleString("zh-CN") : "—"}</strong></span></div>}
        <div className="editor-frame panel">
            <div className="editor-toolbar">
                <div className="editor-tabs">{mode === "prompts" ? promptTabs.map((tab) => <button type="button" key={tab.id} className={`editor-tab${resourceId === tab.id ? " active" : ""}`} onClick={() => void chooseTab(tab.id)}>{tab.label}{resourceId === tab.id && dirty ? " •" : ""}</button>) : <span className="editor-tab active">memes.json</span>}</div>
                <div className="editor-actions">{mode === "memes" && <button type="button" className="button button-secondary" onClick={formatJson} disabled={!draft || saving}>格式化 JSON</button>}
                    <button type="button" className="button button-secondary" onClick={() => void loadResource(resourceId)} disabled={loading || saving || dirty}>重新载入</button>
                    <button type="button" className="button button-primary" onClick={() => void save()} disabled={!dirty || saving}>{saving ? "保存中…" : "保存  Ctrl+S"}</button></div>
            </div>
            {error && <div className="settings-feedback error editor-error" role="alert">{error}</div>}
            <div className="editor-surface">{draft ? <Editor path={draft.resource.id} language={draft.resource.language} theme="vs-dark" value={draft.content} onChange={(value) => setDraft((current) => current ? editDraft(current, value ?? "") : current)} options={{ automaticLayout: true, minimap: { enabled: false }, fontFamily: "Noto Sans, Noto Sans SC, sans-serif", fontSize: 15, lineHeight: 23, scrollBeyondLastLine: false, wordWrap: "on", padding: { top: 16, bottom: 16 } }} /> : <div className="editor-loading">{loading ? "正在载入编辑器…" : "资源不可用"}</div>}</div>
            <div className="editor-footer"><span>{draft?.resource.displayName ?? "—"}</span><span>{draft ? `${draft.content.split(/\r?\n/).length} 行 · UTF-8` : ""}</span></div>
        </div>
    </section>;
}
