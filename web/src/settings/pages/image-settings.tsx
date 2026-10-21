import React from "react";
import type { ImageModelCapabilities } from "../../api/types.js";
import { parseImageDimensions } from "../../../../src/ai/image-capabilities.js";
import { getGptModelPickerEntries, gptModelCategoryLabel, gptModelClassificationLabel } from "../../../../src/ai/model-classification.js";
import { PanelHeading, SettingField, imageQualityLabel, imageSizeLabel } from "../settings-fields.js";
import type { ModelCatalogProps, SettingsPageProps } from "../settings-page-types.js";
import type { SettingsValues } from "../settings-state.js";

const CONSERVATIVE_IMAGE_CAPABILITIES: ImageModelCapabilities = {
    quality: ["low"], sizes: ["1024x1024"], outputFormats: ["png"], supportsAutoSize: false, supportsCustomSize: false, source: "conservative",
};
const CUSTOM_IMAGE_MODEL = "__custom_image_model__";
const CUSTOM_IMAGE_SIZE = "__custom_image_size__";

export function ImageSettings({
    form, saving, fieldError, edit, catalog, loading, error, refresh,
    customModel, onCustomModelChange, customSizeSelected, onCustomSizeSelectedChange,
    customWidth, onCustomWidthChange, customHeight, onCustomHeightChange,
}: SettingsPageProps & ModelCatalogProps & {
    customModel: boolean;
    onCustomModelChange(value: boolean): void;
    customSizeSelected: boolean;
    onCustomSizeSelectedChange(value: boolean): void;
    customWidth: string;
    onCustomWidthChange(value: string): void;
    customHeight: string;
    onCustomHeightChange(value: string): void;
}) {
    const selectedModel = form.values["image.model"];
    const selectedCandidate = catalog?.imageCandidates.find((candidate) => candidate.id === selectedModel);
    const selectedModelEntry = catalog?.entries.find((entry) => entry.id === selectedModel);
    const imagePickerEntries = getGptModelPickerEntries(catalog?.entries ?? [], "image", selectedModel);
    const imageModelEntries = imagePickerEntries.recommended;
    const imageCapabilities = selectedCandidate?.capabilities ?? catalog?.defaultImageCapabilities ?? CONSERVATIVE_IMAGE_CAPABILITIES;
    const selectedSize = form.values["image.size"];
    const parsedSize = parseImageDimensions(selectedSize);
    const customSizeMode = customSizeSelected || Boolean(imageCapabilities.supportsCustomSize && parsedSize && !imageCapabilities.sizes.includes(selectedSize));
    const imageSizeSelectValue = customSizeMode ? CUSTOM_IMAGE_SIZE : selectedSize;

    return <React.Fragment><section className="panel settings-panel image-generation-panel">
        <PanelHeading index="04" title="AI 绘图" hint="供 /绘图 命令使用；不改变普通对话模型" />
        <div className="setting-toggle-row image-generation-toggle">
            <div className="setting-toggle-copy">
                <label htmlFor="setting-image-enabled">启用绘图</label>
                <span id="setting-image-enabled-hint">{form.values["image.enabled"] ? "已启用；使用 /绘图 提示词生成图片。" : "已禁用；模型和参数会保留，/绘图 不会发起新请求。"}</span>
                {fieldError("image.enabled") && <span className="field-error">{fieldError("image.enabled")}</span>}
            </div>
            <input id="setting-image-enabled" className="setting-toggle-input" type="checkbox" aria-describedby="setting-image-enabled-hint" checked={form.values["image.enabled"]} disabled={saving} onChange={(event) => edit("image.enabled", event.currentTarget.checked)} />
        </div>
        <div className="settings-grid image-settings-grid">
            <SettingField label="上游来源" id="setting-image-provider" hint="复用 GPT Provider 的 Base URL 与 API Key；密钥仅保存在后端。"><select id="setting-image-provider" value={form.values["image.provider"]} disabled><option value="gpt">GPT Provider 当前上游</option></select></SettingField>
            <SettingField label="绘图模型" id="setting-image-model" error={fieldError("image.model")}>
                <select id="setting-image-model" value={customModel ? CUSTOM_IMAGE_MODEL : selectedModel} disabled={saving || loading} aria-invalid={Boolean(fieldError("image.model"))} onChange={(event) => {
                    const value = event.currentTarget.value;
                    if (value === CUSTOM_IMAGE_MODEL) onCustomModelChange(true);
                    else { onCustomModelChange(false); edit("image.model", value); }
                }}>
                    {!selectedModel && <option value="">请选择绘图模型</option>}
                    {selectedModel && (imagePickerEntries.preservedCurrent || !imagePickerEntries.currentIsListed) && <option value={selectedModel}>{selectedModel}（当前保存值{selectedModelEntry ? `，分类为${gptModelCategoryLabel(selectedModelEntry.category)}，不在推荐图像列表中` : loading ? "，模型列表读取中" : error ? "，模型列表不可用" : "，不在上游列表中"}）</option>}
                    {imageModelEntries.map((model) => {
                        const candidate = catalog?.imageCandidates.find((item) => item.id === model.id);
                        return <option key={model.id} value={model.id}>{model.displayName}（{gptModelCategoryLabel(model.category)}，{model.classificationSource === "provider" ? "上游元数据标记" : gptModelClassificationLabel(model.classificationSource)}{candidate ? "" : "，生图能力待确认"}）</option>;
                    })}
                    <option value={CUSTOM_IMAGE_MODEL}>自定义模型 ID…</option>
                </select>
                {customModel && <input id="setting-image-model-custom" type="text" aria-label="自定义绘图模型 ID" placeholder="输入 OpenAI 兼容上游支持的绘图模型 ID" value={selectedModel} disabled={saving} aria-invalid={Boolean(fieldError("image.model"))} onChange={(event) => edit("image.model", event.currentTarget.value)} />}
                <div className="model-picker-actions"><span className="field-hint" role="status" aria-live="polite">{loading ? "正在读取 GPT 上游模型列表…" : error ? catalog ? `刷新失败，仍使用上次列表：${error}` : `模型列表读取失败：${error}` : catalog?.imageCandidates.length ? `已读取 ${catalog.imageCandidates.length} 个图像类模型；分类仅用于筛选，不代表当前上游已验证支持 Images API。` : "暂无图像类候选；可手动填写上游支持的模型 ID。分类结果不代表 Images API 已验证。"}</span><button type="button" className="button button-secondary" disabled={saving || loading} onClick={refresh}>{loading ? "读取中…" : "刷新模型"}</button></div>
            </SettingField>
            <SettingField label="生成质量" id="setting-image-quality" error={fieldError("image.quality")}>
                <select id="setting-image-quality" value={form.values["image.quality"]} disabled={saving || loading} aria-invalid={Boolean(fieldError("image.quality"))} onChange={(event) => edit("image.quality", event.currentTarget.value as SettingsValues["image.quality"])}>
                    {!imageCapabilities.quality.includes(form.values["image.quality"]) && <option value={form.values["image.quality"]}>{form.values["image.quality"]}（当前值不在此模型档案中）</option>}
                    {imageCapabilities.quality.map((value) => <option key={value} value={value}>{imageQualityLabel(value)}</option>)}
                </select>
            </SettingField>
            <SettingField label="默认图片尺寸" id="setting-image-size" error={fieldError("image.size")}>
                <select id="setting-image-size" value={imageSizeSelectValue} disabled={saving || loading} aria-invalid={Boolean(fieldError("image.size"))} onChange={(event) => {
                    const value = event.currentTarget.value;
                    if (value === CUSTOM_IMAGE_SIZE) {
                        onCustomSizeSelectedChange(true); onCustomWidthChange(""); onCustomHeightChange(""); edit("image.size", "");
                    } else { onCustomSizeSelectedChange(false); edit("image.size", value); }
                }}>
                    {!customSizeMode && !imageCapabilities.sizes.includes(selectedSize) && <option value={selectedSize}>{selectedSize || "尺寸未设置"}（当前值不在此模型档案中）</option>}
                    {imageCapabilities.sizes.map((value) => <option key={value} value={value}>{imageSizeLabel(value)}</option>)}
                    {imageCapabilities.supportsCustomSize && <option value={CUSTOM_IMAGE_SIZE}>自定义尺寸…</option>}
                </select>
                {customSizeMode && <div className="image-size-custom" aria-label="自定义图片尺寸">
                    <input id="setting-image-size-width" type="number" min="16" max="3840" step="16" aria-label="自定义图片宽度" placeholder="宽度" value={customWidth} disabled={saving || loading} aria-invalid={Boolean(fieldError("image.size"))} onChange={(event) => { const width = event.currentTarget.value; onCustomWidthChange(width); edit("image.size", width && customHeight ? `${width}x${customHeight}` : ""); }} />
                    <span>×</span>
                    <input id="setting-image-size-height" type="number" min="16" max="3840" step="16" aria-label="自定义图片高度" placeholder="高度" value={customHeight} disabled={saving || loading} aria-invalid={Boolean(fieldError("image.size"))} onChange={(event) => { const height = event.currentTarget.value; onCustomHeightChange(height); edit("image.size", customWidth && height ? `${customWidth}x${height}` : ""); }} />
                </div>}
            </SettingField>
            <SettingField label="图片输出格式" id="setting-image-format" error={fieldError("image.outputFormat")}>
                <select id="setting-image-format" value={form.values["image.outputFormat"]} disabled={saving || loading} aria-invalid={Boolean(fieldError("image.outputFormat"))} onChange={(event) => edit("image.outputFormat", event.currentTarget.value as SettingsValues["image.outputFormat"])}>
                    {!imageCapabilities.outputFormats.includes(form.values["image.outputFormat"]) && <option value={form.values["image.outputFormat"]}>{form.values["image.outputFormat"]}（当前值不在此模型档案中）</option>}
                    {imageCapabilities.outputFormats.map((value) => <option key={value} value={value}>{value.toUpperCase()}</option>)}
                </select>
            </SettingField>
        </div>
        <p className="image-capability-note">{selectedCandidate?.capabilities.source === "upstream" ? "此上游提供了图像能力参数；保存时仍会按项目参数档案复核。" : imageCapabilities.source === "openai-sdk-profile" ? "参数选项来自项目随 OpenAI SDK 维护的兼容档案，不是对当前上游的实时探测。" : "未知或自定义模型仅提供 low、1024×1024、PNG 保守选项；模型名本身不能证明其支持生图。"}</p>
        {selectedSize === "auto" && <p className="image-capability-note">自动模式会将 <code>size: "auto"</code> 原样传给绘图模型，实际宽高以生成文件为准。</p>}
    </section></React.Fragment>;
}
