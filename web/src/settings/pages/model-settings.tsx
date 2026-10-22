import React from "react";
import { getGptModelPickerEntries, gptModelOptionLabel } from "../../../../src/ai/model-classification.js";
import { PanelHeading, SettingField } from "../settings-fields.js";
import type { ModelCatalogProps, SettingsPageProps } from "../settings-page-types.js";
import type { SettingsValues } from "../settings-state.js";

const reasoningOptions = [["none", "关闭"], ["low", "低"], ["medium", "中"], ["high", "高"], ["xhigh", "极高"]] as const;
const verbosityOptions = [["low", "简洁"], ["medium", "标准"], ["high", "详细"]] as const;
const CUSTOM_GPT_MODEL = "__custom_gpt_model__";

export function ModelSettings({
    form, saving, fieldError, edit, catalog, loading, error, refresh,
    showOtherModels, onShowOtherModelsChange, customModel, onCustomModelChange,
}: SettingsPageProps & ModelCatalogProps & {
    showOtherModels: boolean;
    onShowOtherModelsChange(value: boolean): void;
    customModel: boolean;
    onCustomModelChange(value: boolean): void;
}) {
    const selectedModel = form.values["gpt.model"];
    const models = catalog?.models ?? [];
    const entries = catalog?.entries ?? [];
    const picker = getGptModelPickerEntries(entries, "chat", selectedModel, showOtherModels);
    const hidden = Boolean(selectedModel && !picker.recommended.some((entry) => entry.id === selectedModel));

    return <React.Fragment><section className="panel settings-panel">
        <PanelHeading index="01" title="主模型预设" hint="选择预设后，只编辑对应模型参数" />
        <div className="preset-selector" role="group" aria-label="主模型预设">
            {(["gpt", "deepseek"] as const).map((provider) => <button className={`preset-option${form.values.aiProvider === provider ? " active" : ""}`} type="button" key={provider} aria-pressed={form.values.aiProvider === provider} disabled={saving} onClick={() => edit("aiProvider", provider)}>
                <span className="preset-icon">{provider === "gpt" ? "G" : "D"}</span><span><strong>{provider === "gpt" ? "GPT" : "DeepSeek"}</strong><small>{form.baseline.aiProvider === provider ? "当前运行" : "备用预设"}</small></span><span className={form.baseline[provider].configured ? "configured-text" : "unconfigured-text"}>{form.baseline[provider].configured ? "已配置" : "未配置"}</span>
            </button>)}
        </div>
        <div className="preset-fields" key={form.values.aiProvider}>
            {form.values.aiProvider === "gpt" ? <div className="settings-grid settings-grid-preset">
                <SettingField label="模型" id="setting-gpt-model">
                    <select className="model-picker-select" id="setting-gpt-model" value={customModel ? CUSTOM_GPT_MODEL : selectedModel} disabled={saving || loading} onChange={(event) => {
                        const value = event.currentTarget.value;
                        if (value === CUSTOM_GPT_MODEL) onCustomModelChange(true);
                        else { onCustomModelChange(false); edit("gpt.model", value); }
                    }}>
                        {!selectedModel && <option value="">请选择聊天模型</option>}
                        {hidden && <option value={selectedModel}>{selectedModel}</option>}
                        {showOtherModels ? <>
                            <optgroup label="聊天 / 推理 / 编程模型">{picker.recommended.filter((model) => model.category === "chat").map((model) => <option key={model.id} value={model.id}>{gptModelOptionLabel(model)}</option>)}</optgroup>
                            {picker.recommended.some((model) => model.category !== "chat" && model.category !== "unknown") && <optgroup label="其他类型模型（选择前请确认用途）">{picker.recommended.filter((model) => model.category !== "chat" && model.category !== "unknown").map((model) => <option key={model.id} value={model.id}>{gptModelOptionLabel(model)}</option>)}</optgroup>}
                            {picker.recommended.some((model) => model.category === "unknown") && <optgroup label="未知类型（请确认上游用途）">{picker.recommended.filter((model) => model.category === "unknown").map((model) => <option key={model.id} value={model.id}>{gptModelOptionLabel(model)}</option>)}</optgroup>}
                        </> : <optgroup label="推荐聊天模型">{picker.recommended.map((model) => <option key={model.id} value={model.id}>{gptModelOptionLabel(model)}</option>)}</optgroup>}
                        <option value={CUSTOM_GPT_MODEL}>自定义模型 ID…</option>
                    </select>
                    {customModel && <input id="setting-gpt-model-custom" type="text" aria-label="自定义 GPT 聊天模型 ID" placeholder="输入上游支持的模型 ID" value={selectedModel} disabled={saving} onChange={(event) => edit("gpt.model", event.currentTarget.value)} />}
                    <label className="model-picker-toggle" htmlFor="setting-gpt-show-other-models"><input id="setting-gpt-show-other-models" type="checkbox" checked={showOtherModels} disabled={saving} onChange={(event) => onShowOtherModelsChange(event.currentTarget.checked)} />显示其他类型模型（包括未知模型）</label>
                    <div className="model-picker-actions">
                        <span className="field-hint" role="status" aria-live="polite">{loading ? "正在读取上游模型列表…" : error ? models.length ? `刷新失败，仍显示上次列表：${error}` : `模型列表读取失败：${error}` : models.length ? `已获取 ${models.length} 个模型；默认只显示聊天类模型` : "上游暂未返回可用模型"}</span>
                        <button type="button" className="button button-secondary" disabled={saving || loading} onClick={refresh}>{loading ? "读取中…" : "刷新列表"}</button>
                    </div>
                    {!loading && (Boolean(selectedModel && !models.includes(selectedModel)) || hidden) && <span className="field-hint" role="status">当前值会保留，不会因分类、过滤或列表查询失败而自动替换。</span>}
                </SettingField>
                <SettingField label="推理强度" id="setting-gpt-reasoning"><select id="setting-gpt-reasoning" value={form.values["gpt.reasoningEffort"]} disabled={saving} onChange={(event) => edit("gpt.reasoningEffort", event.currentTarget.value as SettingsValues["gpt.reasoningEffort"])}>{reasoningOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></SettingField>
                <SettingField label="输出详细度" id="setting-gpt-verbosity"><select id="setting-gpt-verbosity" value={form.values["gpt.verbosity"]} disabled={saving} onChange={(event) => edit("gpt.verbosity", event.currentTarget.value as SettingsValues["gpt.verbosity"])}>{verbosityOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></SettingField>
            </div> : <div className="settings-grid settings-grid-preset">
                <SettingField label="模型" id="setting-deepseek-model" error={fieldError("deepseek.model")}><input id="setting-deepseek-model" type="text" value={form.values["deepseek.model"]} disabled={saving} aria-invalid={Boolean(fieldError("deepseek.model"))} onChange={(event) => edit("deepseek.model", event.currentTarget.value)} /></SettingField>
                <SettingField label="推理强度" id="setting-deepseek-reasoning"><select id="setting-deepseek-reasoning" value={form.values["deepseek.reasoningEffort"]} disabled={saving} onChange={(event) => edit("deepseek.reasoningEffort", event.currentTarget.value as SettingsValues["deepseek.reasoningEffort"])}>{reasoningOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></SettingField>
            </div>}
        </div>
    </section></React.Fragment>;
}
