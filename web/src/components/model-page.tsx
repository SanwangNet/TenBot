import { useRuntime } from "../runtime/runtime-context.js";

function Row({ label, value }: { label: string; value: string }) {
    return <div className="detail-row"><span>{label}</span><strong>{value}</strong></div>;
}

export function ModelPage() {
    const { status, config } = useRuntime();
    return <section className="model-page">
        <div className="page-heading"><div><div className="eyebrow">CONTROL PLANE / MODELS</div><h1>模型</h1><p>当前 Runtime 正在使用的模型与能力。参数调整请前往设置。</p></div></div>
        <div className="model-page-grid">
            <section className="panel model-observe-panel">
                <div className="panel-heading"><div className="panel-title"><span className="panel-index">01</span><h2>主模型</h2></div><span className="panel-hint">运行中</span></div>
                <div className="model-hero"><span className="model-provider-mark">{status?.provider.id === "gpt" ? "G" : "D"}</span><div><span className="eyebrow">{status?.provider.id.toUpperCase() ?? "—"}</span><h3>{status?.provider.model ?? "等待 Runtime…"}</h3></div></div>
                <div className="detail-list">
                    <Row label="Provider" value={status?.provider.id === "gpt" ? "GPT" : status?.provider.id === "deepseek" ? "DeepSeek" : "—"} />
                    <Row label="推理强度" value={status?.provider.reasoningEffort ?? "—"} />
                    {status?.provider.verbosity && <Row label="输出详细度" value={status.provider.verbosity} />}
                    <Row label="Web Search" value={status ? status.provider.webSearch ? "支持" : "不支持" : "—"} />
                    <Row label="配置状态" value={status ? status.provider.configured ? "已配置" : "未配置" : "—"} />
                </div>
            </section>
            <section className="panel model-observe-panel">
                <div className="panel-heading"><div className="panel-title"><span className="panel-index">02</span><h2>回复判断</h2></div><span className="panel-hint">Reply Judge</span></div>
                <div className="model-hero"><span className="model-provider-mark judge-mark">J</span><div><span className="eyebrow">{config?.replyJudge.provider ?? "未启用 Provider"}</span><h3>{config?.replyJudge.model || "未配置模型"}</h3></div></div>
                <div className="detail-list">
                    <Row label="Provider" value={config?.replyJudge.provider ?? "未配置"} />
                    <Row label="Model" value={config?.replyJudge.model || "—"} />
                    <Row label="Timeout" value={config ? `${config.replyJudge.timeoutMs} ms` : "—"} />
                </div>
            </section>
        </div>
    </section>;
}
