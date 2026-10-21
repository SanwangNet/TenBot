import type { ImageGenerationConfig, ImageModelCapabilities, PublicConfig, PublicConfigPatch } from "../api/types.js";
import { imageSizeSupportedByCapabilities, parseImageDimensions, validateGptImage2CustomSize } from "../../../src/ai/image-capabilities.js";

export type ImageSettingsField =
    | "image.enabled"
    | "image.provider"
    | "image.model"
    | "image.quality"
    | "image.size"
    | "image.outputFormat";
export type SettingsField = Exclude<PublicConfigPatch["field"], "image"> | ImageSettingsField;
export type SavedSettingsField = SettingsField | "image";

export interface SettingsValues {
    aiProvider: PublicConfig["aiProvider"];
    memeSendMaxEdge: string;
    "gpt.model": string;
    "gpt.reasoningEffort": PublicConfig["gpt"]["reasoningEffort"];
    "gpt.verbosity": PublicConfig["gpt"]["verbosity"];
    "deepseek.model": string;
    "deepseek.reasoningEffort": PublicConfig["deepseek"]["reasoningEffort"];
    "replyJudge.model": string;
    "replyJudge.timeoutMs": string;
    "replyJudge.fallbackToMainOnInvalidOutput": boolean;
    "replyJudge.turnWaitMs": string;
    "botLoopGuard.maxCycles": string;
    "image.enabled": boolean;
    "image.provider": ImageGenerationConfig["provider"];
    "image.model": string;
    "image.quality": ImageGenerationConfig["quality"];
    "image.size": ImageGenerationConfig["size"];
    "image.outputFormat": ImageGenerationConfig["outputFormat"];
}

export interface SettingsFormState {
    baseline: PublicConfig;
    values: SettingsValues;
    externalConflict: boolean;
}

const SETTINGS_FIELDS: readonly SettingsField[] = [
    "aiProvider",
    "memeSendMaxEdge",
    "gpt.model",
    "gpt.reasoningEffort",
    "gpt.verbosity",
    "deepseek.model",
    "deepseek.reasoningEffort",
    "replyJudge.model",
    "replyJudge.timeoutMs",
    "replyJudge.fallbackToMainOnInvalidOutput",
    "replyJudge.turnWaitMs",
    "botLoopGuard.maxCycles",
    "image.enabled",
    "image.provider",
    "image.model",
    "image.quality",
    "image.size",
    "image.outputFormat",
];

export function createSettingsForm(config: PublicConfig): SettingsFormState {
    return {
        baseline: config,
        values: {
            aiProvider: config.aiProvider,
            memeSendMaxEdge: config.memeSendMaxEdge === null ? "original" : String(config.memeSendMaxEdge),
            "gpt.model": config.gpt.model,
            "gpt.reasoningEffort": config.gpt.reasoningEffort,
            "gpt.verbosity": config.gpt.verbosity,
            "deepseek.model": config.deepseek.model,
            "deepseek.reasoningEffort": config.deepseek.reasoningEffort,
            "replyJudge.model": config.replyJudge.model,
            "replyJudge.timeoutMs": String(config.replyJudge.timeoutMs),
            "replyJudge.fallbackToMainOnInvalidOutput": config.replyJudge.fallbackToMainOnInvalidOutput,
            "replyJudge.turnWaitMs": String(config.replyJudge.turnWaitMs / 1_000),
            "botLoopGuard.maxCycles": String(config.botLoopGuard.maxCycles),
            "image.enabled": config.image.enabled,
            "image.provider": config.image.provider,
            "image.model": config.image.model,
            "image.quality": config.image.quality,
            "image.size": config.image.size,
            "image.outputFormat": config.image.outputFormat,
        },
        externalConflict: false,
    };
}

function baselineValue(config: PublicConfig, field: SettingsField): string {
    switch (field) {
        case "aiProvider": return config.aiProvider;
        case "memeSendMaxEdge": return config.memeSendMaxEdge === null ? "original" : String(config.memeSendMaxEdge);
        case "gpt.model": return config.gpt.model;
        case "gpt.reasoningEffort": return config.gpt.reasoningEffort;
        case "gpt.verbosity": return config.gpt.verbosity;
        case "deepseek.model": return config.deepseek.model;
        case "deepseek.reasoningEffort": return config.deepseek.reasoningEffort;
        case "replyJudge.model": return config.replyJudge.model;
        case "replyJudge.timeoutMs": return String(config.replyJudge.timeoutMs);
        case "replyJudge.fallbackToMainOnInvalidOutput": return String(config.replyJudge.fallbackToMainOnInvalidOutput);
        case "replyJudge.turnWaitMs": return String(config.replyJudge.turnWaitMs / 1_000);
        case "botLoopGuard.maxCycles": return String(config.botLoopGuard.maxCycles);
        case "image.enabled": return String(config.image.enabled);
        case "image.provider": return config.image.provider;
        case "image.model": return config.image.model;
        case "image.quality": return config.image.quality;
        case "image.size": return config.image.size;
        case "image.outputFormat": return config.image.outputFormat;
    }
}

export function dirtySettingsFields(form: SettingsFormState): SettingsField[] {
    return SETTINGS_FIELDS.filter((field) => String(form.values[field]) !== baselineValue(form.baseline, field));
}

/** Saving a preset never writes fields belonging to the hidden provider. */
export function visibleDirtySettingsFields(form: SettingsFormState): SettingsField[] {
    return dirtySettingsFields(form).filter((field) =>
        field === "aiProvider" || (!field.startsWith("gpt.") && !field.startsWith("deepseek.")) || field.startsWith(`${form.values.aiProvider}.`));
}

export function parseTimeoutInput(value: string): number | null {
    if (!/^\d+$/.test(value.trim())) return null;
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) && parsed >= 1_000 && parsed <= 30_000 ? parsed : null;
}

export function parseTurnWaitSecondsInput(value: string): number | null {
    if (!/^\d+(?:\.\d{1,3})?$/.test(value.trim())) return null;
    const milliseconds = Number(value.trim()) * 1_000;
    return Number.isSafeInteger(milliseconds) && milliseconds >= 1_000 && milliseconds <= 60_000 ? milliseconds : null;
}

function parsePositiveInteger(value: string): number | null {
    if (!/^\d+$/.test(value.trim())) return null;
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}

export function settingsFieldError(
    field: SettingsField,
    values: SettingsValues,
    imageCapabilities: ImageModelCapabilities = { quality: ["low"], sizes: ["1024x1024"], outputFormats: ["png"], supportsAutoSize: false, supportsCustomSize: false, source: "conservative" },
): string | undefined {
    const value = String(values[field]);
    if (field === "memeSendMaxEdge" && value !== "original" && (!/^\d+$/.test(value) || Number(value) < 32 || Number(value) > 1_024)) {
        return "请选择原始尺寸或 32 到 1024 px 之间的整数";
    }
    if (field === "gpt.model" || field === "deepseek.model" || field === "replyJudge.model") {
        return value.trim() ? undefined : "请填写模型名称";
    }
    if (field === "replyJudge.timeoutMs" && parseTimeoutInput(value) === null) return "请输入 1000 到 30000 之间的整数毫秒";
    if (field === "replyJudge.turnWaitMs" && parseTurnWaitSecondsInput(value) === null) return "请输入 1 到 60 秒之间的值，最多精确到毫秒";
    if (field === "botLoopGuard.maxCycles" && parsePositiveInteger(value) === null) return "请输入大于等于 1 的整数";
    if (isImageSettingsField(field)) return imageFieldError(field, values, imageCapabilities);
    return undefined;
}

export function settingsPatches(form: SettingsFormState): PublicConfigPatch[] {
    const fields = visibleDirtySettingsFields(form);
    const imageChanged = fields.some((field) => field.startsWith("image."));
    const patches = fields.filter((field) => !field.startsWith("image.")).flatMap((field): PublicConfigPatch[] => {
        const value = form.values[field];
        const textValue = String(value);
        switch (field) {
            case "aiProvider": return [{ field, value: value as PublicConfig["aiProvider"] }];
            case "memeSendMaxEdge": return [{ field, value: textValue === "original" ? null : Number(textValue) }];
            case "gpt.model":
            case "deepseek.model":
            case "replyJudge.model": return [{ field, value: textValue.trim() }];
            case "gpt.reasoningEffort": return [{ field, value: value as PublicConfig["gpt"]["reasoningEffort"] }];
            case "deepseek.reasoningEffort": return [{ field, value: value as PublicConfig["deepseek"]["reasoningEffort"] }];
            case "gpt.verbosity": return [{ field, value: value as PublicConfig["gpt"]["verbosity"] }];
            case "replyJudge.timeoutMs": {
                const parsed = parseTimeoutInput(textValue);
                return parsed === null ? [] : [{ field, value: parsed }];
            }
            case "replyJudge.fallbackToMainOnInvalidOutput": return [{ field, value: value as boolean }];
            case "image.enabled":
            case "image.provider":
            case "image.model":
            case "image.quality":
            case "image.size":
            case "image.outputFormat": return [];
            case "replyJudge.turnWaitMs": {
                const parsed = parseTurnWaitSecondsInput(textValue);
                return parsed === null ? [] : [{ field, value: parsed }];
            }
            case "botLoopGuard.maxCycles": {
                const parsed = parsePositiveInteger(textValue);
                return parsed === null ? [] : [{ field, value: parsed }];
            }
        }
    });
    if (imageChanged) patches.push({ field: "image", value: imageConfigFromValues(form.values) });
    return patches;
}

type SettingsEditAction = {
    [Field in SettingsField]: { type: "edit"; field: Field; value: SettingsValues[Field] }
}[SettingsField];

export type SettingsFormAction =
    | { type: "server-refresh"; config: PublicConfig }
    | SettingsEditAction
    | { type: "saved"; config: PublicConfig; field: SavedSettingsField }
    | { type: "reload"; config: PublicConfig };

function valueFromConfig(config: PublicConfig, field: SettingsField): string | boolean {
    switch (field) {
        case "aiProvider": return config.aiProvider;
        case "memeSendMaxEdge": return config.memeSendMaxEdge === null ? "original" : String(config.memeSendMaxEdge);
        case "gpt.model": return config.gpt.model;
        case "gpt.reasoningEffort": return config.gpt.reasoningEffort;
        case "gpt.verbosity": return config.gpt.verbosity;
        case "deepseek.model": return config.deepseek.model;
        case "deepseek.reasoningEffort": return config.deepseek.reasoningEffort;
        case "replyJudge.model": return config.replyJudge.model;
        case "replyJudge.timeoutMs": return String(config.replyJudge.timeoutMs);
        case "replyJudge.fallbackToMainOnInvalidOutput": return config.replyJudge.fallbackToMainOnInvalidOutput;
        case "replyJudge.turnWaitMs": return String(config.replyJudge.turnWaitMs / 1_000);
        case "botLoopGuard.maxCycles": return String(config.botLoopGuard.maxCycles);
        case "image.enabled": return config.image.enabled;
        case "image.provider": return config.image.provider;
        case "image.model": return config.image.model;
        case "image.quality": return config.image.quality;
        case "image.size": return config.image.size;
        case "image.outputFormat": return config.image.outputFormat;
    }
}

function hasDirtyValues(form: SettingsFormState): boolean {
    return dirtySettingsFields(form).length > 0;
}

export function settingsFormReducer(state: SettingsFormState | null, action: SettingsFormAction): SettingsFormState | null {
    if (action.type === "server-refresh") {
        if (!state || !hasDirtyValues(state)) return createSettingsForm(action.config);
        if (JSON.stringify(state.baseline) === JSON.stringify(action.config)) return state;
        return state.externalConflict ? state : { ...state, externalConflict: true };
    }
    if (action.type === "reload") return createSettingsForm(action.config);
    if (action.type === "edit") {
        if (!state) return state;
        return { ...state, values: { ...state.values, [action.field]: action.value } };
    }
    if (action.type === "saved") {
        if (!state) return createSettingsForm(action.config);
        if (action.field === "image") return createSettingsFormAfterSave(state, action.config);
        return {
            ...state,
            baseline: action.config,
            values: { ...state.values, [action.field]: valueFromConfig(action.config, action.field) } as SettingsValues,
            externalConflict: false,
        };
    }
    return state;
}

function imageConfigFromValues(values: SettingsValues): ImageGenerationConfig {
    return {
        enabled: values["image.enabled"],
        provider: values["image.provider"],
        model: values["image.model"],
        quality: values["image.quality"],
        size: values["image.size"],
        outputFormat: values["image.outputFormat"],
    };
}

function isImageSettingsField(field: SettingsField): field is ImageSettingsField {
    return field.startsWith("image.");
}

function imageFieldError(field: ImageSettingsField, values: SettingsValues, capabilities: ImageModelCapabilities): string | undefined {
    const config = imageConfigFromValues(values);
    if (field === "image.model" && (config.model.length > 128 || /[\r\n]/.test(config.model))) {
        return "模型 ID 不能换行且长度不能超过 128 个字符";
    }
    if (field === "image.size" || field === "image.model" || field === "image.enabled") {
        if (config.size !== "auto" && !parseImageDimensions(config.size)) return "请输入有效的宽度 × 高度尺寸";
        if (config.size !== "auto" && capabilities.supportsCustomSize && !capabilities.sizes.includes(config.size) &&
            !validateGptImage2CustomSize(config.size)) {
            return "自定义尺寸须为 16 的倍数，长宽比不超过 3:1，边长不超过 3840，像素总数为 655360 到 8294400";
        }
    }
    if (!config.enabled) return undefined;
    if (!config.model.trim()) return "启用绘图前请先选择或填写绘图模型";
    if ((field === "image.enabled" || field === "image.model" || field === "image.quality") && !capabilities.quality.includes(config.quality)) {
        return `当前模型参数档案不支持质量 ${config.quality}`;
    }
    if ((field === "image.enabled" || field === "image.model" || field === "image.size") && !imageSizeSupportedByCapabilities(config.size, capabilities)) {
        return `当前模型参数档案不支持尺寸 ${config.size}`;
    }
    if ((field === "image.enabled" || field === "image.model" || field === "image.outputFormat") && !capabilities.outputFormats.includes(config.outputFormat)) {
        return `当前模型参数档案不支持格式 ${config.outputFormat}`;
    }
    return undefined;
}

function createSettingsFormAfterSave(state: SettingsFormState, config: PublicConfig): SettingsFormState {
    const refreshed = createSettingsForm(config);
    return {
        ...refreshed,
        values: {
            ...refreshed.values,
            ...Object.fromEntries(Object.keys(state.values)
                .filter((key) => !key.startsWith("image."))
                .map((key) => [key, state.values[key as keyof SettingsValues]])),
        } as SettingsValues,
    };
}
