import { useEffect, useRef, useState } from "react";
import { apiClient, ApiError } from "../api/client.js";
import { useFeedback } from "../ui/feedback.js";
import { prepareMemeImage, type MemeResizeTarget } from "./meme-image.js";
import "./meme-library.css";

interface PendingImage { id: string; file: File; name: string }
type ResizeChoice = "240" | "300" | "384" | "512" | "original";

function bytesToBase64(bytes: Uint8Array): string {
    let binary = "";
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
}

function defaultName(filename: string): string {
    return filename.replace(/\.[^.]+$/, "").trim();
}

export function MemeLibraryPage() {
    const [files, setFiles] = useState<string[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [open, setOpen] = useState(false);
    const [pending, setPending] = useState<PendingImage[]>([]);
    const [resizeChoice, setResizeChoice] = useState<ResizeChoice>("300");
    const [busy, setBusy] = useState(false);
    const [busyName, setBusyName] = useState<string | null>(null);
    const [fileErrors, setFileErrors] = useState<Record<string, string>>({});
    const [dragging, setDragging] = useState(false);
    const fileInput = useRef<HTMLInputElement>(null);
    const { confirm, notify } = useFeedback();

    async function refresh(signal?: AbortSignal) {
        const response = await apiClient.getMemeLibrary(signal);
        setFiles(response.files);
        setError(null);
    }

    useEffect(() => {
        const controller = new AbortController();
        void refresh(controller.signal).catch(() => {
            if (!controller.signal.aborted) setError("无法读取本地表情包库");
        }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
        return () => controller.abort();
    }, []);

    function addFiles(list: FileList | File[]) {
        const next = Array.from(list).map((file) => ({
            id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            file,
            name: defaultName(file.name),
        }));
        if (!next.length) return;
        setPending((current) => [...current, ...next]);
        setFileErrors({});
        setOpen(true);
    }

    function updatePending(id: string, patch: Partial<PendingImage>) {
        setPending((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
    }

    async function uploadAll() {
        if (busy || !pending.length) return;
        setBusy(true);
        let added = 0;
        for (const item of pending) {
            setBusyName(item.id);
            try {
                const target = resizeChoice === "original" ? null : Number(resizeChoice) as MemeResizeTarget;
                const prepared = await prepareMemeImage(item.file, target);
                const result = await apiClient.uploadMeme(item.name, bytesToBase64(prepared.bytes));
                added++;
                setPending((current) => current.filter((candidate) => candidate.id !== item.id));
                setFileErrors((current) => { const next = { ...current }; delete next[item.id]; return next; });
                notify("success", prepared.preservedOriginal
                    ? `${result.filename} 已添加；为保留动画使用了原始尺寸`
                    : `${result.filename} 已添加`);
            } catch (cause) {
                const message = cause instanceof ApiError || cause instanceof Error ? cause.message : "图片处理失败";
                setFileErrors((current) => ({ ...current, [item.id]: message }));
            }
        }
        setBusyName(null);
        setBusy(false);
        if (added) await refresh().catch(() => setError("表情包已保存，但列表刷新失败"));
    }

    async function deleteFile(filename: string) {
        const approved = await confirm({
            title: "删除表情包",
            message: `确定删除“${filename}”？此操作无法撤销。`,
            confirmLabel: "确认删除",
            danger: true,
        });
        if (!approved) return;
        setBusyName(filename);
        try {
            await apiClient.deleteMeme(filename);
            setFiles((current) => current.filter((item) => item !== filename));
            notify("success", `已删除 ${filename}`);
        } catch (cause) {
            notify("error", cause instanceof ApiError ? cause.message : "删除表情包失败");
        } finally { setBusyName(null); }
    }

    function closeDialog() {
        if (busy) return;
        setOpen(false);
        setPending([]);
        setFileErrors({});
    }

    return <section className="meme-library-page">
        <div className="page-heading">
            <div><div className="eyebrow">LOCAL RESOURCES / MEMES</div><h1>表情包</h1><p>管理主模型可选择并由 QQ 单独发送的本地图片资源。</p></div>
            <button className="button button-primary meme-add-button" type="button" onClick={() => setOpen(true)}>＋ 添加表情包</button>
        </div>
        {error && <div className="settings-feedback error" role="alert">{error}<button className="button button-secondary" type="button" onClick={() => void refresh().catch(() => setError("无法读取本地表情包库"))}>重试</button></div>}
        {loading ? <div className="panel meme-empty">正在读取表情包…</div> : files.length ? <div className="meme-grid">
            {files.map((filename) => <article className="meme-card" key={filename}>
                <img src={apiClient.memePreviewUrl(filename)} alt={filename} loading="lazy" />
                <div className="meme-card-overlay"><span title={filename}>{filename}</span>
                    <button type="button" className="meme-delete-button" disabled={busyName === filename} aria-label={`删除 ${filename}`} title={`删除 ${filename}`} onClick={() => void deleteFile(filename)}>删除</button>
                </div>
            </article>)}
        </div> : <div className="panel meme-empty"><strong>表情包库还是空的</strong><span>添加图片后，模型会在每轮回复时看到可用文件名。</span><button className="button button-secondary" type="button" onClick={() => setOpen(true)}>添加第一张</button></div>}

        {open && <div className="meme-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeDialog(); }}>
            <section className="meme-dialog" role="dialog" aria-modal="true" aria-labelledby="meme-dialog-title">
                <header><div><div className="eyebrow">LOCAL IMAGE UPLOAD</div><h2 id="meme-dialog-title">添加表情包</h2></div><button className="meme-dialog-close" type="button" disabled={busy} aria-label="关闭" onClick={closeDialog}>×</button></header>
                <label className={`meme-dropzone${dragging ? " dragging" : ""}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); addFiles(event.dataTransfer.files); }}>
                    <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/gif,image/webp" multiple onChange={(event) => { if (event.currentTarget.files) addFiles(event.currentTarget.files); event.currentTarget.value = ""; }} />
                    <strong>拖入图片，或点击选择文件</strong><span>支持 JPEG、PNG、GIF、WebP；可一次选择多张，单张最大 16 MB。</span>
                </label>
                <label className="meme-resize-setting"><span>上传时最长边</span><select value={resizeChoice} onChange={(event) => setResizeChoice(event.target.value as ResizeChoice)} disabled={busy}>
                    <option value="240">240 px</option><option value="300">300 px（默认）</option><option value="384">384 px</option><option value="512">512 px</option><option value="original">保持原尺寸</option>
                </select><small>只缩小大图，不放大小图；GIF、动画 WebP/APNG 为保留动画会使用原始文件。</small></label>
                {pending.length > 0 && <div className="meme-upload-queue"><div className="meme-queue-heading">待添加 <span>{pending.length} 张</span></div>
                    {pending.map((item) => <div className="meme-queue-row" key={item.id}>
                        <div className="meme-queue-file" title={item.file.name}><strong>{item.file.name}</strong><span>{(item.file.size / 1024).toFixed(0)} KB</span></div>
                        <label><span className="sr-only">{item.file.name} 的表情包名称</span><input value={item.name} maxLength={80} disabled={busy} onChange={(event) => updatePending(item.id, { name: event.target.value })} placeholder="名称 / 描述" /></label>
                        <button type="button" className="meme-remove-pending" disabled={busy} aria-label={`移除 ${item.file.name}`} onClick={() => setPending((current) => current.filter((candidate) => candidate.id !== item.id))}>×</button>
                        {fileErrors[item.id] && <span className="meme-upload-error" role="alert">{fileErrors[item.id]}</span>}
                        {busyName === item.id && <span className="meme-uploading">处理中…</span>}
                    </div>)}
                </div>}
                <footer><span>QQ /添加表情会保留 QQ 提供的原始尺寸。</span><button type="button" className="button button-secondary" disabled={busy} onClick={closeDialog}>取消</button><button type="button" className="button button-primary" disabled={busy || !pending.length} onClick={() => void uploadAll()}>{busy ? "正在添加…" : "添加表情包"}</button></footer>
            </section>
        </div>}
    </section>;
}
