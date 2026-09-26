import type { ReactNode } from "react";
import { useLastRuntimeEventAt, useRuntime } from "../runtime/runtime-context.js";
import type { RuntimeStatus } from "../api/types.js";

const connectionLabels: Record<RuntimeStatus["qq"], string> = {
    connecting: "连接中",
    connected: "已连接",
    disconnected: "未连接",
    error: "连接异常",
};

const connectionTone: Record<RuntimeStatus["qq"], string> = {
    connecting: "warning",
    connected: "good",
    disconnected: "muted",
    error: "bad",
};

export function OverviewPage() {
    const { status, config, connection, loading } = useRuntime();
    const lastRuntimeEventAt = useLastRuntimeEventAt();
    const waiting = loading && !status;

    return (
        <>
            <div className="page-heading">
                <div>
                    <div className="eyebrow">CONTROL PLANE / OVERVIEW</div>
                    <h1>总览</h1>
                    <p>查看 TenBot Runtime 当前状态与运行数据。</p>
                </div>
                <div className="heading-runtime"><span className={`status-dot ${connection === "online" ? "good" : connection === "offline" ? "bad" : "warning"}`} />{connectionText(connection)}</div>
            </div>

            <div className="overview-grid">
                <Panel className="runtime-panel" title="Runtime" icon="01" hint="实时状态">
                    <div className="metric-row">
                        <Metric label="QQ 连接" value={status ? connectionLabels[status.qq] : waiting ? "读取中" : "未知"} tone={status ? connectionTone[status.qq] : "muted"} />
                        <Metric label="Active Reply Cycles" value={status?.activeCycles ?? "—"} />
                        <Metric label="Context Conversations" value={status?.contextConversations ?? "—"} />
                    </div>
                    <div className="panel-divider" />
                    <div className="detail-list">
                        <Detail label="配置修订" value={status?.hotReload ? `r${status.hotReload.revision}` : "—"} />
                        <Detail label="热重载" value={status?.hotReload ? (status.hotReload.enabled ? "已启用" : "已停用") : "—"} />
                        <Detail label="最近配置加载" value={formatDate(status?.hotReload?.lastSuccessAt)} />
                    </div>
                    {status?.hotReload?.requiresRestart && <div className="notice warning-notice">QQ 配置已变更，需要重启 Runtime。</div>}
                    {status?.hotReload?.lastFailure && <div className="notice warning-notice">最近一次热重载失败，Runtime 继续使用旧配置。</div>}
                </Panel>

                <Panel className="model-panel" title="Main Model" icon="02" hint={status?.provider.configured ? "已配置" : status ? "未配置" : "等待数据"}>
                    <div className="model-title">
                        <span className="provider-badge">{status?.provider.id === "deepseek" ? "DS" : "GPT"}</span>
                        <div><strong>{status?.provider.model ?? (waiting ? "读取中" : "—")}</strong><small>{status?.provider.id ?? "当前 Provider"}</small></div>
                        <span className={`configured-indicator ${status?.provider.configured ? "good" : status ? "bad" : "muted"}`} title={status?.provider.configured ? "已配置" : "未配置"} />
                    </div>
                    <div className="detail-list model-details">
                        <Detail label="Reasoning" value={status?.provider.reasoningEffort ?? "—"} />
                        <Detail label="Verbosity" value={status?.provider.verbosity ?? "—"} />
                        <Detail label="Web Search" value={status ? (status.provider.webSearch ? "可用" : "不可用") : "—"} />
                        <Detail label="配置状态" value={status ? (status.provider.configured ? "Configured" : "Not configured") : "—"} />
                    </div>
                </Panel>

                <Panel title="Reply Judge" icon="03" hint="回复判断">
                    <div className="large-value overview-judge-model">{config?.replyJudge.model || "未配置"}</div>
                    <div className="detail-list">
                        <Detail label="Provider" value={config?.replyJudge.provider ?? "未配置"} />
                        <Detail label="Timeout" value={config ? `${config.replyJudge.timeoutMs} ms` : "—"} />
                    </div>
                </Panel>

                <Panel title="Prompt" icon="04" hint={status?.prompt.provider ?? "活动快照"}>
                    <div className="large-value">{status ? `r${status.prompt.revision}` : "—"}</div>
                    <div className="detail-list">
                        <Detail label="Provider" value={status?.prompt.provider ?? "—"} />
                        <Detail label="Loaded At" value={formatDate(status?.prompt.loadedAt)} />
                        <Detail label="Characters" value={status?.prompt.characters?.toLocaleString() ?? "—"} />
                        <Detail label="Lines" value={status?.prompt.lines?.toLocaleString() ?? "—"} />
                    </div>
                </Panel>

                <Panel title="Memes" icon="05" hint="本地知识库">
                    <div className="large-value">{status?.memes.count.toLocaleString() ?? "—"}<span className="large-suffix"> 条</span></div>
                    <div className="detail-list">
                        <Detail label="Revision" value={status ? `r${status.memes.revision}` : "—"} />
                        <Detail label="Loaded At" value={formatDate(status?.memes.loadedAt)} />
                    </div>
                </Panel>

                <Panel className="web-panel" title="Web Control" icon="06" hint="HTTP + SSE">
                    <div className="control-connection">
                        <span className={`status-dot ${connection === "online" ? "good" : connection === "offline" ? "bad" : "warning"}`} />
                        <strong>{connectionText(connection)}</strong>
                    </div>
                    <div className="detail-list">
                        <Detail label="SSE Connection" value={connectionText(connection)} />
                        <Detail label="最近 Runtime Event" value={formatDate(lastRuntimeEventAt)} />
                    </div>
                </Panel>
            </div>
        </>
    );
}

function Panel({ title, icon, hint, className = "", children }: { title: string; icon: string; hint?: string; className?: string; children: ReactNode }) {
    return (
        <section className={`panel ${className}`}>
            <div className="panel-heading">
                <div className="panel-title"><span className="panel-index">{icon}</span><h2>{title}</h2></div>
                {hint && <span className="panel-hint">{hint}</span>}
            </div>
            {children}
        </section>
    );
}

function Metric({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
    return <div className="metric"><span className="metric-label">{label}</span><strong className={tone ? `text-${tone}` : undefined}>{value}</strong></div>;
}

function Detail({ label, value }: { label: string; value: string }) {
    return <div className="detail-row"><span>{label}</span><strong title={value}>{value}</strong></div>;
}

function formatDate(value: string | undefined | null) {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("zh-CN", { hour12: false });
}

function connectionText(state: string) {
    if (state === "online") return "在线";
    if (state === "offline") return "离线";
    if (state === "reconnecting") return "正在重新连接";
    return "正在连接";
}
