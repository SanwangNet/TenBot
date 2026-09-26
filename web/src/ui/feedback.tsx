import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { ProviderErrorNotice } from "../api/types.js";
import { addNotice, type Notice, type NoticeTone } from "./feedback-state.js";

interface DialogOptions { title: string; message: string; confirmLabel?: string; danger?: boolean; details?: ProviderErrorNotice }
interface DialogState extends DialogOptions { resolve(value: boolean): void }
interface FeedbackContextValue {
    notify(tone: NoticeTone, message: string, details?: ProviderErrorNotice): void;
    confirm(options: DialogOptions): Promise<boolean>;
}
const FeedbackContext = createContext<FeedbackContextValue | null>(null);

export function FeedbackProvider({ children }: { children: ReactNode }) {
    const [notices, setNotices] = useState<Notice[]>([]);
    const [dialog, setDialog] = useState<DialogState | null>(null);
    const notify = useCallback((tone: NoticeTone, message: string, details?: ProviderErrorNotice) => {
        const id = Date.now() + Math.random();
        setNotices((current) => addNotice(current, { id, tone, message, count: 1, details }));
        if (tone !== "error") window.setTimeout(() => setNotices((current) => current.filter((item) => item.id !== id)), 5000);
    }, []);
    const confirm = useCallback((options: DialogOptions) => new Promise<boolean>((resolve) => setDialog({ ...options, resolve })), []);
    const closeDialog = (value: boolean) => { dialog?.resolve(value); setDialog(null); };
    useEffect(() => {
        if (!dialog) return;
        const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); dialog.resolve(false); setDialog(null); } };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [dialog]);
    const value = useMemo(() => ({ notify, confirm }), [notify, confirm]);
    return <FeedbackContext.Provider value={value}>
        {children}
        <div className="toast-stack" aria-live="polite">
            {notices.map((notice) => <div className={`toast toast-${notice.tone}`} key={notice.id} role={notice.tone === "error" ? "alert" : "status"}>
                <span className="toast-symbol">{notice.tone === "success" ? "✓" : notice.tone === "error" ? "!" : "•"}</span>
                <span>{notice.message}{notice.count > 1 && <strong> ×{notice.count}</strong>}</span>
                {notice.details && <button type="button" onClick={() => void confirm({ title: "Provider Error", message: notice.details!.message, details: notice.details, confirmLabel: "关闭" })}>详情</button>}
                <button type="button" aria-label="关闭提示" onClick={() => setNotices((current) => current.filter((item) => item.id !== notice.id))}>×</button>
            </div>)}
        </div>
        {dialog && <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeDialog(false); }}>
            <section className="dialog" role="dialog" aria-modal="true" aria-label={dialog.title}>
                <h2>{dialog.title}</h2><p>{dialog.message}</p>
                {dialog.details && <dl className="dialog-details">
                    <dt>Provider</dt><dd>{dialog.details.provider}</dd><dt>Model</dt><dd>{dialog.details.model}</dd>
                    <dt>TenBot Code</dt><dd>{dialog.details.tenbotCode}</dd><dt>HTTP</dt><dd>{dialog.details.status ?? "—"}</dd>
                    <dt>Details</dt><dd>{dialog.details.details ?? "—"}</dd>
                </dl>}
                <div className="dialog-actions">
                    {!dialog.details && <button className="button button-secondary" type="button" onClick={() => closeDialog(false)}>取消</button>}
                    <button className={`button ${dialog.danger ? "button-danger" : "button-primary"}`} type="button" autoFocus onClick={() => closeDialog(true)}>{dialog.confirmLabel ?? "确认"}</button>
                </div>
            </section>
        </div>}
    </FeedbackContext.Provider>;
}

export function useFeedback() {
    const value = useContext(FeedbackContext);
    if (!value) throw new Error("useFeedback must be used inside FeedbackProvider");
    return value;
}
