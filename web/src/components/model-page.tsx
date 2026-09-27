import { useRuntime } from "../runtime/runtime-context.js";

function Row({ label, value }: { label: string; value: string }) {
    return <div className="detail-row"><span>{label}</span><strong>{value}</strong></div>;
}

export function ModelPage() {
    const { status, config } = useRuntime();
    return <section className="model-page">
        <div className="page-heading"><div><div className="eyebrow">控制中心 / 模型</div><h1>模型</h1><p>运行时当前使用的模型与能力。参数调整请前往设置。</p></div></div>
        <div className="model-page-grid">
            <section className="panel model-observe-panel">
                <div className="panel-heading"><div className="panel-title"><span className="panel-index">01</span><h2>主模型</h2></div><span className="panel-hint">运行中</span></div>
                <div className="model-hero"><span className="model-provider-mark">{status?.provider.id === "gpt" ? "G" : "D"}</span><div><span className="eyebrow">{status?.provider.id.toUpperCase() ?? "—"}</span><h3>{status?.provider.model ?? "等待运行时…"}</h3></div></div>
                <div className="detail-list">
                    <Row label="服务商" value={status?.provider.id === "gpt" ? "GPT" : status?.provider.id === "deepseek" ? "DeepSeek" : "—"} />
                    <Row label="推理强度" value={status?.provider.reasoningEffort ?? "—"} />
                    {status?.provider.verbosity && <Row label="输出详细度" value={status.provider.verbosity} />}
                    <Row label="联网搜索" value={status ? status.provider.webSearch ? "支持" : "不支持" : "—"} />
                    <Row label="配置状态" value={status ? status.provider.configured ? "已配置" : "未配置" : "—"} />
                </div>
            </section>
            <section className="panel model-observe-panel">
                <div className="panel-heading"><div className="panel-title"><span className="panel-index">02</span><h2>回复判断</h2></div><span className="panel-hint">模型评估</span></div>
                <div className="model-hero"><span className="model-provider-mark judge-mark">J</span><div><span className="eyebrow">{config?.replyJudge.provider ?? "未启用服务商"}</span><h3>{config?.replyJudge.model || "未配置模型"}</h3></div></div>
                <div className="detail-list">
                    <Row label="服务商" value={config?.replyJudge.provider ?? "未配置"} />
                    <Row label="模型" value={config?.replyJudge.model || "—"} />
                    <Row label="超时时间" value={config ? `${config.replyJudge.timeoutMs} 毫秒` : "—"} />
                </div>
            </section>
        </div>
    </section>;
}
