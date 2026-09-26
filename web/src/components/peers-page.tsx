import { useEffect, useState } from "react";
import { apiClient, ApiError } from "../api/client.js";
import type { AutomatedPeerSummary, KnownMemberSummary } from "../api/types.js";
import { useFeedback } from "../ui/feedback.js";
import { usePeerRevision } from "../runtime/runtime-context.js";

interface Directory { registered: AutomatedPeerSummary[]; recent: AutomatedPeerSummary[]; known: KnownMemberSummary[] }
export function PeersPage() {
    const [directory, setDirectory] = useState<Directory>({ registered: [], recent: [], known: [] });
    const [busyId, setBusyId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const { confirm, notify } = useFeedback();
    const peerRevision = usePeerRevision();
    async function refresh(signal?: AbortSignal) {
        const [peers, known] = await Promise.all([apiClient.getAutomatedPeers(signal), apiClient.getKnownMembers(signal)]);
        setDirectory({ ...peers, known });
        setError(null);
    }
    useEffect(() => {
        const controller = new AbortController();
        void refresh(controller.signal).catch(() => { if (!controller.signal.aborted) setError("无法读取账号目录"); });
        return () => controller.abort();
    }, [peerRevision]);
    async function mutate(action: "add" | "remove", peer: AutomatedPeerSummary) {
        const approved = await confirm({ title: action === "add" ? "登记自动账号" : "移除自动账号", message: `${action === "add" ? "将" : "从登记列表移除"} ${peer.displayName}（${peer.displayId}）${action === "add" ? "加入自动账号？" : "？"}`, confirmLabel: action === "add" ? "确认添加" : "确认移除", danger: action === "remove" });
        if (!approved) return;
        setBusyId(peer.id);
        try {
            const result = action === "add" ? await apiClient.addAutomatedPeer(peer.id) : await apiClient.removeAutomatedPeer(peer.id);
            notify("success", result.message);
            await refresh();
        } catch (cause) { notify("error", cause instanceof ApiError ? cause.message : "账号操作失败"); }
        finally { setBusyId(null); }
    }
    return <section className="peers-page">
        <div className="page-heading"><div><div className="eyebrow">CONTROL PLANE / PEERS</div><h1>自动账号</h1><p>管理已登记账号，查看近期出现的账号与已知成员。</p></div></div>
        {error && <div className="settings-feedback error" role="alert">{error}<button className="button button-secondary" onClick={() => void refresh()}>重试</button></div>}
        <div className="peers-grid">
            <section className="panel"><div className="panel-heading"><div className="panel-title"><span className="panel-index">01</span><h2>已登记自动账号</h2></div><span className="panel-hint">{directory.registered.length} 个</span></div>
                {directory.registered.length ? directory.registered.map((peer) => <PeerRow key={peer.id} peer={peer} action="remove" busy={busyId === peer.id} onAction={() => void mutate("remove", peer)} />) : <p className="empty-message">尚未登记自动账号</p>}
            </section>
            <section className="panel"><div className="panel-heading"><div className="panel-title"><span className="panel-index">02</span><h2>最近账号</h2></div><span className="panel-hint">{directory.recent.length} 个</span></div>
                {directory.recent.length ? directory.recent.map((peer) => <PeerRow key={peer.id} peer={peer} action="add" busy={busyId === peer.id} onAction={() => void mutate("add", peer)} />) : <p className="empty-message">暂无最近账号</p>}
            </section>
        </div>
        <section className="panel known-panel"><div className="panel-heading"><div className="panel-title"><span className="panel-index">03</span><h2>Known Members</h2></div><span className="panel-hint">只读 · {directory.known.length} 位</span></div>
            {directory.known.length ? <div className="known-grid">{directory.known.map((member) => <div className="known-row" key={member.id}><strong>{member.displayName}</strong><code>{member.displayId}</code><span>{member.groupCount} 个群 · {new Date(member.lastSeenAt).toLocaleString("zh-CN")}</span></div>)}</div> : <p className="empty-message">暂无已知成员</p>}
        </section>
    </section>;
}

function PeerRow({ peer, action, busy, onAction }: { peer: AutomatedPeerSummary; action: "add" | "remove"; busy: boolean; onAction(): void }) {
    return <div className="peer-row"><div><strong>{peer.displayName}</strong><span><code>{peer.displayId}</code>{peer.platformBotHint ? " · 平台 Bot" : ""}{peer.lastSeenAt ? ` · ${new Date(peer.lastSeenAt).toLocaleString("zh-CN")}` : ""}</span></div>
        <button className={`button ${action === "add" ? "button-primary" : "button-secondary"}`} disabled={busy} type="button" onClick={onAction}>{busy ? "处理中…" : action === "add" ? "添加" : "移除"}</button></div>;
}
