import { useEffect, useReducer, useState, type FormEvent, type ReactNode } from "react";
import { apiClient, ApiError } from "../api/client.js";
import type { GptModelsResponse, ImageGenerationQuality, ImageModelCapabilities, PublicConfigPatch } from "../api/types.js";
import { useRuntime } from "../runtime/runtime-context.js";
import { useFeedback } from "../ui/feedback.js";
import { parseImageDimensions } from "../../../src/ai/image-capabilities.js";
import {
    getGptModelPickerEntries,
    gptModelCategoryLabel,
    gptModelClassificationLabel,
    gptModelOptionLabel,
} from "../../../src/ai/model-classification.js";
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
const memeSendSizeOptions = [[96, "96 px"], [128, "128 px"], [160, "160 px"], [200, "200 px"], [240, "240 px"]] as const;
const memeSendPresetValues = new Set(memeSendSizeOptions.map(([value]) => String(value)));
const CONSERVATIVE_IMAGE_CAPABILITIES: ImageModelCapabilities = {
    quality: ["low"], sizes: ["1024x1024"], outputFormats: ["png"], supportsAutoSize: false, supportsCustomSize: false, source: "conservative",
};
const CUSTOM_IMAGE_MODEL = "__custom_image_model__";
const CUSTOM_IMAGE_SIZE = "__custom_image_size__";
const CUSTOM_GPT_MODEL = "__custom_gpt_model__";

export function SettingsPage() {
    const { config, acceptConfig } = useRuntime();
    const { notify } = useFeedback();
    const [form, dispatch] = useReducer(settingsFormReducer, config, (initial) => initial ? createSettingsForm(initial) : null);
    const [saving, setSaving] = useState(false);
    const [feedback, setFeedback] = useState<Feedback>(null);
    const [gptCatalog, setGptCatalog] = useState<GptModelsResponse | null>(null);
    const [modelsLoading, setModelsLoading] = useState(false);
    const [modelsError, setModelsError] = useState<string | null>(null);
    const [modelsRefresh, setModelsRefresh] = useState(0);
    const [showOtherGptModels, setShowOtherGptModels] = useState(false);
    const [customGptModel, setCustomGptModel] = useState(false);
    const [customImageModel, setCustomImageModel] = useState(false);
    const [customImageSizeSelected, setCustomImageSizeSelected] = useState(false);
    const [customImageWidth, setCustomImageWidth] = useState("");
    const [customImageHeight, setCustomImageHeight] = useState("");

    useEffect(() => {
        if (config) dispatch({ type: "server-refresh", config });
    }, [config]);

    useEffect(() => {
        if (!form || (form.values.aiProvider !== "gpt" && form.values["image.provider"] !== "gpt")) return;
        const controller = new AbortController();
        setModelsLoading(true);
        setModelsError(null);
        void apiClient.getGptModels(controller.signal)
            .then((catalog) => setGptCatalog(catalog))
            .catch((cause: unknown) => {
                if (!controller.signal.aborted) {
                    setModelsError(cause instanceof ApiError ? cause.message : "无法读取 GPT 模型列表");
                }
            })
            .finally(() => {
                if (!controller.signal.aborted) setModelsLoading(false);
            });
        return () => controller.abort();
    }, [form?.values.aiProvider, form?.values["image.provider"], modelsRefresh]);

    const dirtyFields = form ? visibleDirtySettingsFields(form) : [];
    const hiddenDirtyCount = form ? dirtySettingsFields(form).length - dirtyFields.length : 0;
    const selectedImageModel = form?.values["image.model"] ?? "";
    const selectedImageCandidate = gptCatalog?.imageCandidates.find((candidate) => candidate.id === selectedImageModel);
    const selectedImageModelEntry = gptCatalog?.entries.find((entry) => entry.id === selectedImageModel);
    const imagePickerEntries = getGptModelPickerEntries(gptCatalog?.entries ?? [], "image", selectedImageModel);
    const imageModelEntries = imagePickerEntries.recommended;
    const imageCapabilities = selectedImageCandidate?.capabilities ?? gptCatalog?.defaultImageCapabilities ?? CONSERVATIVE_IMAGE_CAPABILITIES;
    const selectedImageSize = form?.values["image.size"] ?? "";
    const parsedSelectedImageSize = parseImageDimensions(selectedImageSize);
    const customSizeAvailable = imageCapabilities.supportsCustomSize;
    const customSizeMode = customImageSizeSelected || Boolean(customSizeAvailable && parsedSelectedImageSize && !imageCapabilities.sizes.includes(selectedImageSize));
    const imageSizeSelectValue = customSizeMode ? CUSTOM_IMAGE_SIZE : selectedImageSize;
    const invalidFields = form ? dirtyFields.filter((field) => settingsFieldError(field, form.values, imageCapabilities)) : [];
    const selectedGptModel = form?.values["gpt.model"] ?? "";
    const gptModels = gptCatalog?.models ?? [];
    const selectedGptModelUnavailable = !gptModels.includes(selectedGptModel);
    const gptModelEntries = gptCatalog?.entries ?? [];
    const gptPickerEntries = getGptModelPickerEntries(gptModelEntries, "chat", selectedGptModel, showOtherGptModels);
    const visibleGptModels = gptPickerEntries.recommended;
    const selectedGptModelEntry = gptModelEntries.find((entry) => entry.id === selectedGptModel);
    const selectedGptModelHidden = Boolean(selectedGptModel && !visibleGptModels.some((entry) => entry.id === selectedGptModel));
    const selectedGptModelLabel = modelsLoading ? "（当前值，列表读取中）"
        : modelsError ? "（当前值，列表不可用）"
            : selectedGptModelEntry
                ? `（当前值，${gptModelCategoryLabel(selectedGptModelEntry.category)}，不在推荐聊天列表中）`
                : "（当前值不在上游列表中）";

    useEffect(() => {
        if (!form) return;
        const dimensions = parseImageDimensions(form.values["image.size"]);
        if (dimensions && imageCapabilities.supportsCustomSize && !imageCapabilities.sizes.includes(form.values["image.size"])) {
            setCustomImageSizeSelected(true);
            setCustomImageWidth(String(dimensions.width));
            setCustomImageHeight(String(dimensions.height));
        } else {
            setCustomImageSizeSelected(false);
            setCustomImageWidth("");
            setCustomImageHeight("");
        }
    }, [selectedImageModel, form?.baseline.image.size, imageCapabilities.supportsCustomSize]);

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

    const fieldError = (field: SettingsField) => settingsFieldError(field, form.values, imageCapabilities);
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
                        <SettingField label="模型" id="setting-gpt-model">
                            <select id="setting-gpt-model" value={customGptModel ? CUSTOM_GPT_MODEL : selectedGptModel} disabled={saving || modelsLoading} onChange={(event) => {
                                const value = event.currentTarget.value;
                                if (value === CUSTOM_GPT_MODEL) setCustomGptModel(true);
                                else {
                                    setCustomGptModel(false);
                                    edit("gpt.model", value);
                                }
                            }}>
                                {!selectedGptModel && <option value="">请选择聊天模型</option>}
                                {selectedGptModelHidden && <option value={selectedGptModel}>{selectedGptModel}{selectedGptModelLabel}</option>}
                                {showOtherGptModels ? <>
                                    <optgroup label="聊天 / 推理 / 编程模型">
                                        {visibleGptModels.filter((model) => model.category === "chat").map((model) => <option key={model.id} value={model.id}>{gptModelOptionLabel(model)}</option>)}
                                    </optgroup>
                                    {visibleGptModels.some((model) => model.category !== "chat" && model.category !== "unknown") && <optgroup label="其他类型模型（选择前请确认用途）">
                                        {visibleGptModels.filter((model) => model.category !== "chat" && model.category !== "unknown").map((model) => <option key={model.id} value={model.id}>{gptModelOptionLabel(model)}</option>)}
                                    </optgroup>}
                                    {visibleGptModels.some((model) => model.category === "unknown") && <optgroup label="未知类型（请确认上游用途）">
                                        {visibleGptModels.filter((model) => model.category === "unknown").map((model) => <option key={model.id} value={model.id}>{gptModelOptionLabel(model)}</option>)}
                                    </optgroup>}
                                </> : <optgroup label="推荐聊天模型">
                                    {visibleGptModels.map((model) => <option key={model.id} value={model.id}>{gptModelOptionLabel(model)}</option>)}
                                </optgroup>}
                                <option value={CUSTOM_GPT_MODEL}>自定义模型 ID…</option>
                            </select>
                            {customGptModel && <input
                                id="setting-gpt-model-custom"
                                type="text"
                                aria-label="自定义 GPT 聊天模型 ID"
                                placeholder="输入上游支持的模型 ID"
                                value={selectedGptModel}
                                disabled={saving}
                                onChange={(event) => edit("gpt.model", event.currentTarget.value)}
                            />}
                            <label className="model-picker-toggle" htmlFor="setting-gpt-show-other-models">
                                <input id="setting-gpt-show-other-models" type="checkbox" checked={showOtherGptModels} disabled={saving} onChange={(event) => setShowOtherGptModels(event.currentTarget.checked)} />
                                显示其他类型模型（包括未知模型）
                            </label>
                            <div className="model-picker-actions">
                                <span className="field-hint" role="status" aria-live="polite">
                                    {modelsLoading ? "正在读取上游模型列表…" : modelsError
                                        ? gptModels.length ? `刷新失败，仍显示上次列表：${modelsError}` : `模型列表读取失败：${modelsError}`
                                        : gptModels.length ? `已获取 ${gptModels.length} 个模型；默认只显示聊天类模型` : "上游暂未返回可用模型"}
                                </span>
                                <button type="button" className="button button-secondary" disabled={saving || modelsLoading} onClick={() => setModelsRefresh((value) => value + 1)}>
                                    {modelsLoading ? "读取中…" : "刷新列表"}
                                </button>
                            </div>
                            {!modelsLoading && (selectedGptModelUnavailable || selectedGptModelHidden) && (
                                <span className="field-hint" role="status">当前值会保留，不会因分类、过滤或列表查询失败而自动替换。</span>
                            )}
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

            <section className="panel settings-panel image-generation-panel">
                <PanelHeading index="04" title="AI 绘图" hint="供 /绘图 命令使用；不改变普通对话模型" />
                <div className="setting-toggle-row image-generation-toggle">
                    <div className="setting-toggle-copy">
                        <label htmlFor="setting-image-enabled">启用绘图</label>
                        <span id="setting-image-enabled-hint">{form.values["image.enabled"] ? "已启用；使用 /绘图 提示词生成图片。" : "已禁用；模型和参数会保留，/绘图 不会发起新请求。"}</span>
                        {fieldError("image.enabled") && <span className="field-error">{fieldError("image.enabled")}</span>}
                    </div>
                    <input
                        id="setting-image-enabled"
                        className="setting-toggle-input"
                        type="checkbox"
                        aria-describedby="setting-image-enabled-hint"
                        checked={form.values["image.enabled"]}
                        disabled={saving}
                        onChange={(event) => edit("image.enabled", event.currentTarget.checked)}
                    />
                </div>
                <div className="settings-grid image-settings-grid">
                    <SettingField label="上游来源" id="setting-image-provider" hint="复用 GPT Provider 的 Base URL 与 API Key；密钥仅保存在后端。">
                        <select id="setting-image-provider" value={form.values["image.provider"]} disabled>
                            <option value="gpt">GPT Provider 当前上游</option>
                        </select>
                    </SettingField>
                    <SettingField label="绘图模型" id="setting-image-model" error={fieldError("image.model")}>
                        <select
                            id="setting-image-model"
                            value={customImageModel ? CUSTOM_IMAGE_MODEL : selectedImageModel}
                            disabled={saving || modelsLoading}
                            aria-invalid={Boolean(fieldError("image.model"))}
                            onChange={(event) => {
                                const value = event.currentTarget.value;
                                if (value === CUSTOM_IMAGE_MODEL) setCustomImageModel(true);
                                else {
                                    setCustomImageModel(false);
                                    edit("image.model", value);
                                }
                            }}
                        >
                            {!selectedImageModel && <option value="">请选择绘图模型</option>}
                            {selectedImageModel && (imagePickerEntries.preservedCurrent || !imagePickerEntries.currentIsListed) && (
                                <option value={selectedImageModel}>{selectedImageModel}（当前保存值{selectedImageModelEntry
                                    ? `，分类为${gptModelCategoryLabel(selectedImageModelEntry.category)}，不在推荐图像列表中`
                                    : modelsLoading ? "，模型列表读取中" : modelsError ? "，模型列表不可用" : "，不在上游列表中"}）</option>
                            )}
                            {imageModelEntries.map((model) => {
                                const candidate = gptCatalog?.imageCandidates.find((item) => item.id === model.id);
                                return <option key={model.id} value={model.id}>
                                    {model.displayName}（{gptModelCategoryLabel(model.category)}，{model.classificationSource === "provider"
                                        ? "上游元数据标记"
                                        : gptModelClassificationLabel(model.classificationSource)}{candidate ? "" : "，生图能力待确认"}）
                                </option>
                            })}
                            <option value={CUSTOM_IMAGE_MODEL}>自定义模型 ID…</option>
                        </select>
                        {customImageModel && <input
                            id="setting-image-model-custom"
                            type="text"
                            aria-label="自定义绘图模型 ID"
                            placeholder="输入 OpenAI 兼容上游支持的绘图模型 ID"
                            value={selectedImageModel}
                            disabled={saving}
                            aria-invalid={Boolean(fieldError("image.model"))}
                            onChange={(event) => edit("image.model", event.currentTarget.value)}
                        />}
                        <div className="model-picker-actions">
                            <span className="field-hint" role="status" aria-live="polite">
                                {modelsLoading ? "正在读取 GPT 上游模型列表…" : modelsError
                                    ? gptCatalog ? `刷新失败，仍使用上次列表：${modelsError}` : `模型列表读取失败：${modelsError}`
                                    : gptCatalog?.imageCandidates.length ? `已读取 ${gptCatalog.imageCandidates.length} 个图像类模型；分类仅用于筛选，不代表当前上游已验证支持 Images API。`
                                        : "暂无图像类候选；可手动填写上游支持的模型 ID。分类结果不代表 Images API 已验证。"}
                            </span>
                            <button type="button" className="button button-secondary" disabled={saving || modelsLoading} onClick={() => setModelsRefresh((value) => value + 1)}>
                                {modelsLoading ? "读取中…" : "刷新模型"}
                            </button>
                        </div>
                    </SettingField>
                    <SettingField label="生成质量" id="setting-image-quality" error={fieldError("image.quality")}>
                        <select id="setting-image-quality" value={form.values["image.quality"]} disabled={saving || modelsLoading} aria-invalid={Boolean(fieldError("image.quality"))} onChange={(event) => edit("image.quality", event.currentTarget.value as SettingsValues["image.quality"])}>
                            {!imageCapabilities.quality.includes(form.values["image.quality"]) && <option value={form.values["image.quality"]}>{form.values["image.quality"]}（当前值不在此模型档案中）</option>}
                            {imageCapabilities.quality.map((value) => <option key={value} value={value}>{imageQualityLabel(value)}</option>)}
                        </select>
                    </SettingField>
                    <SettingField label="默认图片尺寸" id="setting-image-size" error={fieldError("image.size")}>
                        <select id="setting-image-size" value={imageSizeSelectValue} disabled={saving || modelsLoading} aria-invalid={Boolean(fieldError("image.size"))} onChange={(event) => {
                            const value = event.currentTarget.value;
                            if (value === CUSTOM_IMAGE_SIZE) {
                                setCustomImageSizeSelected(true);
                                setCustomImageWidth("");
                                setCustomImageHeight("");
                                edit("image.size", "");
                            } else {
                                setCustomImageSizeSelected(false);
                                edit("image.size", value);
                            }
                        }}>
                            {!customSizeMode && !imageCapabilities.sizes.includes(selectedImageSize) && <option value={selectedImageSize}>{selectedImageSize || "尺寸未设置"}（当前值不在此模型档案中）</option>}
                            {imageCapabilities.sizes.map((value) => <option key={value} value={value}>{imageSizeLabel(value)}</option>)}
                            {customSizeAvailable && <option value={CUSTOM_IMAGE_SIZE}>自定义尺寸…</option>}
                        </select>
                        {customSizeMode && <div className="image-size-custom" aria-label="自定义图片尺寸">
                            <input
                                id="setting-image-size-width"
                                type="number"
                                min="16"
                                max="3840"
                                step="16"
                                aria-label="自定义图片宽度"
                                placeholder="宽度"
                                value={customImageWidth}
                                disabled={saving || modelsLoading}
                                aria-invalid={Boolean(fieldError("image.size"))}
                                onChange={(event) => {
                                    const width = event.currentTarget.value;
                                    setCustomImageWidth(width);
                                    edit("image.size", width && customImageHeight ? `${width}x${customImageHeight}` : "");
                                }}
                            />
                            <span>×</span>
                            <input
                                id="setting-image-size-height"
                                type="number"
                                min="16"
                                max="3840"
                                step="16"
                                aria-label="自定义图片高度"
                                placeholder="高度"
                                value={customImageHeight}
                                disabled={saving || modelsLoading}
                                aria-invalid={Boolean(fieldError("image.size"))}
                                onChange={(event) => {
                                    const height = event.currentTarget.value;
                                    setCustomImageHeight(height);
                                    edit("image.size", customImageWidth && height ? `${customImageWidth}x${height}` : "");
                                }}
                            />
                        </div>}
                    </SettingField>
                    <SettingField label="图片输出格式" id="setting-image-format" error={fieldError("image.outputFormat")}>
                        <select id="setting-image-format" value={form.values["image.outputFormat"]} disabled={saving || modelsLoading} aria-invalid={Boolean(fieldError("image.outputFormat"))} onChange={(event) => edit("image.outputFormat", event.currentTarget.value as SettingsValues["image.outputFormat"])}>
                            {!imageCapabilities.outputFormats.includes(form.values["image.outputFormat"]) && <option value={form.values["image.outputFormat"]}>{form.values["image.outputFormat"]}（当前值不在此模型档案中）</option>}
                            {imageCapabilities.outputFormats.map((value) => <option key={value} value={value}>{value.toUpperCase()}</option>)}
                        </select>
                    </SettingField>
                </div>
                <p className="image-capability-note">
                    {selectedImageCandidate?.capabilities.source === "upstream"
                        ? "此上游提供了图像能力参数；保存时仍会按项目参数档案复核。"
                        : imageCapabilities.source === "openai-sdk-profile"
                            ? "参数选项来自项目随 OpenAI SDK 维护的兼容档案，不是对当前上游的实时探测。"
                            : "未知或自定义模型仅提供 low、1024×1024、PNG 保守选项；模型名本身不能证明其支持生图。"}
                </p>
                {selectedImageSize === "auto" && <p className="image-capability-note">自动模式会将 <code>size: "auto"</code> 原样传给绘图模型，实际宽高以生成文件为准。</p>}
            </section>

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

function imageQualityLabel(value: ImageGenerationQuality): string {
    const labels: Record<ImageGenerationQuality, string> = {
        low: "低",
        medium: "中",
        high: "高",
        xhigh: "极高",
        max: "最高",
        auto: "自动",
        standard: "标准",
        hd: "高清",
    };
    return `${labels[value]}（${value}）`;
}

function imageSizeLabel(value: string): string {
    if (value === "auto") return "自动（由绘图模型决定）";
    return value.replace("x", " × ");
}
