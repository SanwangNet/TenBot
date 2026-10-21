import React, { useEffect, useReducer, useState, type FormEvent } from "react";
import { apiClient, ApiError } from "../api/client.js";
import type { GptModelsResponse, ImageModelCapabilities, PublicConfigPatch } from "../api/types.js";
import type { SettingsSection } from "../navigation.js";
import { useRuntime } from "../runtime/runtime-context.js";
import { useFeedback } from "../ui/feedback.js";
import { parseImageDimensions } from "../../../src/ai/image-capabilities.js";
import {
    createSettingsForm,
    dirtySettingsFields,
    dirtySettingsFieldsForSection,
    settingsFieldError,
    settingsFormReducer,
    settingsPatches,
    saveSettingsChanges,
    visibleDirtySettingsFieldsForSection,
    type SettingsField,
    type SettingsFormAction,
    type SettingsValues,
} from "./settings-state.js";
import { SettingsNavigation, SettingsSubheading } from "./settings-navigation.js";
import { ModelSettings } from "./pages/model-settings.js";
import { JudgeSettings } from "./pages/judge-settings.js";
import { RuntimeSettings } from "./pages/runtime-settings.js";
import { ImageSettings } from "./pages/image-settings.js";

type Feedback = { section: SettingsSection; tone: "success" | "error" | "warning"; message: string } | null;
const CONSERVATIVE_IMAGE_CAPABILITIES: ImageModelCapabilities = {
    quality: ["low"], sizes: ["1024x1024"], outputFormats: ["png"], supportsAutoSize: false, supportsCustomSize: false, source: "conservative",
};

export function SettingsPage({ section, onSectionChange, onDirtyChange }: {
    section: SettingsSection;
    onSectionChange(section: SettingsSection): void;
    onDirtyChange(dirty: boolean): void;
}) {
    const { config, acceptConfig } = useRuntime();
    const { notify } = useFeedback();
    const [form, dispatch] = useReducer(settingsFormReducer, config, (initial) => initial ? createSettingsForm(initial) : null);
    const [saving, setSaving] = useState(false);
    const [feedback, setFeedback] = useState<Feedback>(null);
    const [gptCatalog, setGptCatalog] = useState<GptModelsResponse | null>(null);
    const [modelsLoading, setModelsLoading] = useState(false);
    const [modelsError, setModelsError] = useState<string | null>(null);
    const [modelsRefresh, setModelsRefresh] = useState(0);
    const [modelsLoadedRevision, setModelsLoadedRevision] = useState<number | null>(null);
    const [showOtherGptModels, setShowOtherGptModels] = useState(false);
    const [customGptModel, setCustomGptModel] = useState(false);
    const [customImageModel, setCustomImageModel] = useState(false);
    const [customImageSizeSelected, setCustomImageSizeSelected] = useState(false);
    const [customImageWidth, setCustomImageWidth] = useState("");
    const [customImageHeight, setCustomImageHeight] = useState("");

    useEffect(() => {
        if (config) dispatch({ type: "server-refresh", config });
    }, [config]);

    const wantsGptCatalog = Boolean(form && (
        (section === "model" && form.values.aiProvider === "gpt") ||
        (section === "image" && form.values["image.provider"] === "gpt")
    ));
    useEffect(() => {
        if (!form || !wantsGptCatalog || modelsLoadedRevision === modelsRefresh) return;
        const controller = new AbortController();
        setModelsLoading(true);
        setModelsError(null);
        void apiClient.getGptModels(controller.signal)
            .then((catalog) => setGptCatalog(catalog))
            .catch((cause: unknown) => {
                if (!controller.signal.aborted) setModelsError(cause instanceof ApiError ? cause.message : "无法读取 GPT 模型列表");
            })
            .finally(() => {
                if (!controller.signal.aborted) {
                    setModelsLoading(false);
                    setModelsLoadedRevision(modelsRefresh);
                }
            });
        return () => {
            controller.abort();
            setModelsLoading(false);
        };
    }, [form?.values.aiProvider, form?.values["image.provider"], modelsLoadedRevision, modelsRefresh, section, wantsGptCatalog]);

    const selectedImageModel = form?.values["image.model"] ?? "";
    const selectedImageCandidate = gptCatalog?.imageCandidates.find((candidate) => candidate.id === selectedImageModel);
    const imageCapabilities = selectedImageCandidate?.capabilities ?? gptCatalog?.defaultImageCapabilities ?? CONSERVATIVE_IMAGE_CAPABILITIES;
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

    const allDirtyFields = form ? dirtySettingsFields(form) : [];
    useEffect(() => onDirtyChange(allDirtyFields.length > 0), [allDirtyFields.length, onDirtyChange]);

    async function save(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!form || saving || patchesForSubmit.length === 0 || invalidFields.length > 0) return;
        setSaving(true);
        setFeedback(null);
        try {
            const result = await saveSettingsChanges(form, section, apiClient.updateConfig, (response, field) => {
                dispatch({ type: "saved", config: response.config, field });
                acceptConfig(response.config);
            });
            if (!result.ok) {
                const error = result.error;
                const message = error instanceof ApiError ? error.message : "保存配置失败";
                const tone = result.saved > 0 ? "warning" : "error";
                const feedbackMessage = result.saved > 0 ? `已保存 ${result.saved} 项，其余项目未保存：${message}` : message;
                setFeedback({ section, tone, message: feedbackMessage });
                notify(tone, feedbackMessage);
                return;
            }
            const tone = result.requiresRestart ? "warning" : "success";
            const message = result.requiresRestart ? `${result.message} 部分更改需要重启。` : result.message;
            setFeedback({ section, tone, message });
            notify(tone, result.requiresRestart ? "配置已保存，部分更改需要重启" : result.message);
        } finally {
            setSaving(false);
        }
    }

    function edit<Field extends SettingsField>(field: Field, value: SettingsValues[Field]) {
        dispatch({ type: "edit", field, value } as SettingsFormAction);
        setFeedback(null);
    }

    const refreshModels = () => setModelsRefresh((revision) => revision + 1);
    const fieldError = (field: SettingsField) => form ? settingsFieldError(field, form.values, imageCapabilities) : undefined;
    const dirtyFields = form ? dirtySettingsFieldsForSection(form, section) : [];
    const visibleDirtyFields = form ? visibleDirtySettingsFieldsForSection(form, section) : [];
    const patchesForSubmit: PublicConfigPatch[] = form ? settingsPatches(form, section) : [];
    const invalidFields = form ? visibleDirtyFields.filter((field) => settingsFieldError(field, form.values, imageCapabilities)) : [];
    const dirtySections = new Set<SettingsSection>(form ? (['model', 'judge', 'runtime', 'image'] as const).filter((page) => dirtySettingsFieldsForSection(form, page).length > 0) : []);

    if (!form) return <React.Fragment><section className="settings-page"><PageHeading /><div className="panel settings-loading">{config ? "正在载入设置…" : "无法连接 TenBot 运行时，设置暂不可用。"}</div></section></React.Fragment>;

    const hiddenPresetDraftCount = section === "model" ? dirtyFields.length - visibleDirtyFields.length : 0;
    const dirtySummary = visibleDirtyFields.length > 0 ? `${visibleDirtyFields.length} 项未保存`
        : dirtyFields.length > 0 ? "备用预设还有未保存草稿" : "本页已同步";
    const currentFeedback = feedback?.section === section ? feedback : null;

    return <React.Fragment><section className="settings-page">
        <PageHeading />
        <div className="settings-center">
            <SettingsNavigation section={section} dirtySections={dirtySections} onChange={onSectionChange} />
            <div className="settings-content">
                <SettingsSubheading section={section} />
                {form.externalConflict && <div className="settings-conflict" role="status"><span>服务器配置已更新；当前表单有未提交修改，请核对后再保存。</span><button type="button" className="button button-secondary" disabled={!config || saving} onClick={() => config && dispatch({ type: "reload", config })}>重新载入</button></div>}
                {currentFeedback && <div className={`settings-feedback ${currentFeedback.tone}`} role={currentFeedback.tone === "error" ? "alert" : "status"}>{currentFeedback.message}</div>}
                <form className="settings-form" onSubmit={(event) => void save(event)}>
                    {section === "model" ? <ModelSettings
                        form={form} saving={saving} fieldError={fieldError} edit={edit}
                        catalog={gptCatalog} loading={modelsLoading} error={modelsError} refresh={refreshModels}
                        showOtherModels={showOtherGptModels} onShowOtherModelsChange={setShowOtherGptModels}
                        customModel={customGptModel} onCustomModelChange={setCustomGptModel}
                    /> : section === "judge" ? <JudgeSettings form={form} saving={saving} fieldError={fieldError} edit={edit} />
                        : section === "runtime" ? <RuntimeSettings form={form} saving={saving} fieldError={fieldError} edit={edit} />
                            : <ImageSettings
                                form={form} saving={saving} fieldError={fieldError} edit={edit}
                                catalog={gptCatalog} loading={modelsLoading} error={modelsError} refresh={refreshModels}
                                customModel={customImageModel} onCustomModelChange={setCustomImageModel}
                                customSizeSelected={customImageSizeSelected} onCustomSizeSelectedChange={setCustomImageSizeSelected}
                                customWidth={customImageWidth} onCustomWidthChange={setCustomImageWidth}
                                customHeight={customImageHeight} onCustomHeightChange={setCustomImageHeight}
                            />}
                    <div className="settings-actions">
                        <span className="dirty-summary">{dirtySummary}{hiddenPresetDraftCount > 0 ? ` · 另一预设还有 ${hiddenPresetDraftCount} 项草稿` : ""}</span>
                        <button className="button button-primary" type="submit" disabled={saving || patchesForSubmit.length === 0 || invalidFields.length > 0}>{saving ? "保存中…" : "保存本页更改"}</button>
                    </div>
                </form>
                <p className="settings-note">密钥与私密连接信息不会通过网页设置显示或修改。</p>
            </div>
        </div>
    </section></React.Fragment>;
}

function PageHeading() {
    return <React.Fragment><div className="page-heading settings-page-heading"><div><div className="eyebrow">TENBOT 控制台 / 配置</div><h1>设置</h1><p>在设置中心管理模型、回复判断、运行与媒体配置。</p></div></div></React.Fragment>;
}
