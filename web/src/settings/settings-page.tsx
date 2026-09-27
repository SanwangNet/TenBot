import { useEffect, useReducer, useState, type FormEvent, type ReactNode } from "react";
import { apiClient, ApiError } from "../api/client.js";
import type { PublicConfigPatch } from "../api/types.js";
import { useRuntime } from "../runtime/runtime-context.js";
import { useFeedback } from "../ui/feedback.js";
import {
    dirtySettingsFields,
    visibleDirtySettingsFields,
    createSettingsForm,
    settingsFieldError,
    settingsFormReducer,
    settingsPatches,
    type SettingsFormAction,
    type SettingsField,
    type SettingsValues,
} from "./settings-state.js";

type Feedback = { tone: "success" | "error" | "warning"; message: string } | null;

const reasoningOptions = [
    ["none", "关闭"], ["low", "低"], ["medium", "中"], ["high", "高"], ["xhigh", "极高"],
] as const;
const verbosityOptions = [["low", "简洁"], ["medium", "标准"], ["high", "详细"]] as const;
const logLevelOptions = [["all", "全部"], ["debug", "调试"], ["info", "信息"], ["warn", "警告"], ["error", "错误"]] as const;
const memeSendSizeOptions = [[96, "96 px"], [128, "128 px"], [160, "160 px"], [200, "200 px"], [240, "240 px"]] as const;
const memeSendPresetValues = new Set(memeSendSizeOptions.map(([value]) => String(value)));

export function SettingsPage() {
    const { config, acceptConfig } = useRuntime();
    const { notify } = useFeedback();
    const [form, dispatch] = useReducer(settingsFormReducer, config, (initial) => initial ? createSettingsForm(initial) : null);
    const [saving, setSaving] = useState(false);
    const [feedback, setFeedback] = useState<Feedback>(null);

    useEffect(() => {
        if (config) dispatch({ type: "server-refresh", config });
    }, [config]);

    const dirtyFields = form ? visibleDirtySettingsFields(form) : [];
    const hiddenDirtyCount = form ? dirtySettingsFields(form).length - dirtyFields.length : 0;
    const invalidFields = form ? dirtyFields.filter((field) => settingsFieldError(field, form.values)) : [];

    async function save(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!form || saving || dirtyFields.length === 0 || invalidFields.length > 0) return;
        const patches = settingsPatches(form);
        if (patches.length === 0) return;
        setSaving(true);
        setFeedback(null);
        let saved = 0;
        let requiresRestart = false;
        let resultMessage = "配置已保存并立即生效。";
        try {
            for (const patch of patches) {
                const response = await apiClient.updateConfig(patch);
                saved++;
                requiresRestart ||= response.result.requiresRestart;
                resultMessage = response.result.message;
                dispatch({ type: "saved", config: response.config, field: patch.field });
                acceptConfig(response.config);
            }
            setFeedback({
                tone: requiresRestart ? "warning" : "success",
                message: requiresRestart ? `${resultMessage} 部分更改需要重启。` : resultMessage,
            });
            notify(requiresRestart ? "warning" : "success", requiresRestart ? "配置已保存，部分更改需要重启" : resultMessage);
        } catch (cause) {
            const message = cause instanceof ApiError ? cause.message : "保存配置失败";
            setFeedback({
                tone: saved > 0 ? "warning" : "error",
                message: saved > 0 ? `已保存 ${saved} 项，其余项目未保存：${message}` : message,
            });
            notify(saved > 0 ? "warning" : "error", saved > 0 ? `已保存 ${saved} 项，其余项目未保存：${message}` : message);
        } finally {
            setSaving(false);
        }
    }

    function edit<Field extends SettingsField>(field: Field, value: SettingsValues[Field]) {
        dispatch({ type: "edit", field, value } as SettingsFormAction);
        setFeedback(null);
    }

    if (!form) {
        return <section className="settings-page">
            <PageHeading />
            <div className="panel settings-loading">{config ? "正在载入设置…" : "无法连接 TenBot 运行时，设置暂不可用。"}</div>
        </section>;
    }

    const fieldError = (field: SettingsField) => settingsFieldError(field, form.values);
    const patchesForSubmit: PublicConfigPatch[] = settingsPatches(form);

    return <section className="settings-page">
        <PageHeading />
        {form.externalConflict && <div className="settings-conflict" role="status">
            <span>服务器配置已更新；当前表单有未提交修改，请核对后再保存。</span>
            <button type="button" className="button button-secondary" disabled={!config || saving} onClick={() => config && dispatch({ type: "reload", config })}>重新载入</button>
        </div>}
        {feedback && <div className={`settings-feedback ${feedback.tone}`} role={feedback.tone === "error" ? "alert" : "status"}>{feedback.message}</div>}

        <form className="settings-form" onSubmit={(event) => void save(event)}>
            <section className="panel settings-panel">
                <PanelHeading index="01" title="主模型预设" hint="选择预设后，只编辑对应模型参数" />
                <div className="preset-selector" role="group" aria-label="主模型预设">
                    {(["gpt", "deepseek"] as const).map((provider) => <button className={`preset-option${form.values.aiProvider === provider ? " active" : ""}`} type="button" key={provider} aria-pressed={form.values.aiProvider === provider} disabled={saving} onClick={() => edit("aiProvider", provider)}>
                        <span className="preset-icon">{provider === "gpt" ? "G" : "D"}</span><span><strong>{provider === "gpt" ? "GPT" : "DeepSeek"}</strong><small>{form.baseline.aiProvider === provider ? "当前运行" : "备用预设"}</small></span><span className={form.baseline[provider].configured ? "configured-text" : "unconfigured-text"}>{form.baseline[provider].configured ? "已配置" : "未配置"}</span>
                    </button>)}
                </div>
                <div className="preset-fields" key={form.values.aiProvider}>
                    {form.values.aiProvider === "gpt" ? <div className="settings-grid settings-grid-preset">
                        <SettingField label="模型" id="setting-gpt-model" error={fieldError("gpt.model")}>
                            <input id="setting-gpt-model" type="text" value={form.values["gpt.model"]} disabled={saving} aria-invalid={Boolean(fieldError("gpt.model"))} onChange={(event) => edit("gpt.model", event.currentTarget.value)} />
                        </SettingField>
                        <SettingField label="推理强度" id="setting-gpt-reasoning">
                            <select id="setting-gpt-reasoning" value={form.values["gpt.reasoningEffort"]} disabled={saving} onChange={(event) => edit("gpt.reasoningEffort", event.currentTarget.value as SettingsValues["gpt.reasoningEffort"])}>
                                {reasoningOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                            </select>
                        </SettingField>
                        <SettingField label="输出详细度" id="setting-gpt-verbosity">
                            <select id="setting-gpt-verbosity" value={form.values["gpt.verbosity"]} disabled={saving} onChange={(event) => edit("gpt.verbosity", event.currentTarget.value as SettingsValues["gpt.verbosity"])}>
                                {verbosityOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                            </select>
                        </SettingField>
                    </div> : <div className="settings-grid settings-grid-preset">
                        <SettingField label="模型" id="setting-deepseek-model" error={fieldError("deepseek.model")}>
                            <input id="setting-deepseek-model" type="text" value={form.values["deepseek.model"]} disabled={saving} aria-invalid={Boolean(fieldError("deepseek.model"))} onChange={(event) => edit("deepseek.model", event.currentTarget.value)} />
                        </SettingField>
                        <SettingField label="推理强度" id="setting-deepseek-reasoning">
                            <select id="setting-deepseek-reasoning" value={form.values["deepseek.reasoningEffort"]} disabled={saving} onChange={(event) => edit("deepseek.reasoningEffort", event.currentTarget.value as SettingsValues["deepseek.reasoningEffort"])}>
                                {reasoningOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                            </select>
                        </SettingField>
                    </div>}
                </div>
            </section>

            <div className="settings-grid settings-grid-lower">
                <section className="panel settings-panel">
                    <PanelHeading index="02" title="回复判断" hint="评估模型与超时设置" />
                    <SettingField label="模型" id="setting-judge-model" error={fieldError("replyJudge.model")}>
                        <input id="setting-judge-model" type="text" value={form.values["replyJudge.model"]} disabled={saving} aria-invalid={Boolean(fieldError("replyJudge.model"))} onChange={(event) => edit("replyJudge.model", event.currentTarget.value)} />
                    </SettingField>
                    <SettingField label="超时" id="setting-judge-timeout" hint="单位：毫秒；允许范围 1000–30000。" error={fieldError("replyJudge.timeoutMs")}>
                        <input id="setting-judge-timeout" type="number" min="1000" max="30000" step="1" value={form.values["replyJudge.timeoutMs"]} disabled={saving} aria-invalid={Boolean(fieldError("replyJudge.timeoutMs"))} onChange={(event) => edit("replyJudge.timeoutMs", event.currentTarget.value)} />
                    </SettingField>
                    <div className="setting-toggle-row">
                        <div className="setting-toggle-copy">
                            <label htmlFor="setting-judge-ipo-fallback">评估模型异常时交由主模型判断</label>
                            <span id="setting-judge-ipo-fallback-hint">当评估模型返回无效协议输出时交给主模型自行判断；仅处理无效输出，不处理网络或服务商请求失败。</span>
                        </div>
                        <input
                            id="setting-judge-ipo-fallback"
                            className="setting-toggle-input"
                            type="checkbox"
                            aria-describedby="setting-judge-ipo-fallback-hint"
                            checked={form.values["replyJudge.fallbackToMainOnInvalidOutput"]}
                            disabled={saving}
                            onChange={(event) => edit("replyJudge.fallbackToMainOnInvalidOutput", event.currentTarget.checked)}
                        />
                    </div>
                    <SettingField label="未完成发言等待时间" id="setting-judge-turn-wait" hint="单位：秒；允许范围 1–60 秒。" error={fieldError("replyJudge.turnWaitMs")}>
                        <input id="setting-judge-turn-wait" type="number" min="1" max="60" step="0.001" value={form.values["replyJudge.turnWaitMs"]} disabled={saving} aria-invalid={Boolean(fieldError("replyJudge.turnWaitMs"))} onChange={(event) => edit("replyJudge.turnWaitMs", event.currentTarget.value)} />
                    </SettingField>
                </section>

                <section className="panel settings-panel">
                    <PanelHeading index="03" title="运行" hint="保存后由运行时热重载应用" />
                    <SettingField label="日志级别" id="setting-log-level" hint={form.values.logLevel === "all" ? "记录原始请求/响应，可能包含聊天与身份数据，仅建议排障时开启。" : undefined}>
                        <select id="setting-log-level" value={form.values.logLevel} disabled={saving} onChange={(event) => edit("logLevel", event.currentTarget.value as SettingsValues["logLevel"])}>
                            {logLevelOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                        </select>
                    </SettingField>
                    <SettingField label="表情包发送大小" id="setting-meme-send-size" hint="机器人实际发送时的最大边长；不会修改本地原始文件。">
                        <select id="setting-meme-send-size" value={form.values.memeSendMaxEdge} disabled={saving} onChange={(event) => edit("memeSendMaxEdge", event.currentTarget.value)}>
                            <option value="original">原始尺寸</option>
                            {memeSendSizeOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                            {form.values.memeSendMaxEdge !== "original" &&
                                !memeSendSizeOptions.some(([value]) => String(value) === form.values.memeSendMaxEdge) &&
                                <option value={form.values.memeSendMaxEdge}>{form.values.memeSendMaxEdge} px（自定义）</option>}
                        </select>
                        <input
                            type="number"
                            min="32"
                            max="1024"
                            step="1"
                            aria-label="自定义表情包发送边长，32 到 1024 px"
                            placeholder="自定义边长：32–1024 px"
                            value={form.values.memeSendMaxEdge === "original" || memeSendPresetValues.has(form.values.memeSendMaxEdge) ? "" : form.values.memeSendMaxEdge}
                            disabled={saving}
                            aria-invalid={Boolean(fieldError("memeSendMaxEdge"))}
                            onChange={(event) => edit("memeSendMaxEdge", event.currentTarget.value)}
                        />
                    </SettingField>
                    <SettingField label="机器人循环保护 · 最大轮次" id="setting-max-cycles" hint="最小值为 1；后端进行最终校验。" error={fieldError("botLoopGuard.maxCycles")}>
                        <input id="setting-max-cycles" type="number" min="1" step="1" value={form.values["botLoopGuard.maxCycles"]} disabled={saving} aria-invalid={Boolean(fieldError("botLoopGuard.maxCycles"))} onChange={(event) => edit("botLoopGuard.maxCycles", event.currentTarget.value)} />
                    </SettingField>
                </section>
            </div>

            <div className="settings-actions">
                <span className="dirty-summary">{dirtyFields.length > 0 ? `${dirtyFields.length} 项未保存` : "当前预设已同步"}{hiddenDirtyCount > 0 ? ` · 另一预设还有 ${hiddenDirtyCount} 项草稿` : ""}</span>
                <button className="button button-primary" type="submit" disabled={saving || patchesForSubmit.length === 0 || invalidFields.length > 0}>
                    {saving ? "保存中…" : "保存更改"}
                </button>
            </div>
        </form>
        <p className="settings-note">密钥与私密连接信息不会通过网页设置显示或修改。</p>
    </section>;
}

function PageHeading() {
    return <div className="page-heading">
        <div><div className="eyebrow">TENBOT 控制台 / 配置</div><h1>设置</h1><p>管理主模型、回复判断和运行时的公开配置项。</p></div>
    </div>;
}

function PanelHeading({ index, title, hint }: { index: string; title: string; hint: string }) {
    return <div className="panel-heading">
        <div className="panel-title"><span className="panel-index">{index}</span><h2>{title}</h2></div>
        <span className="panel-hint">{hint}</span>
    </div>;
}

function SettingField({ label, id, hint, error, children }: { label: string; id: string; hint?: string; error?: string; children: ReactNode }) {
    return <div className="setting-field">
        <label htmlFor={id}>{label}</label>
        {children}
        {error ? <span className="field-error">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
    </div>;
}
