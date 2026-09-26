import type { PublicConfig, PublicConfigPatch } from "../api/types.js";

export type SettingsField = PublicConfigPatch["field"];

export interface SettingsValues {
    aiProvider: PublicConfig["aiProvider"];
    "gpt.model": string;
    "gpt.reasoningEffort": PublicConfig["gpt"]["reasoningEffort"];
    "gpt.verbosity": PublicConfig["gpt"]["verbosity"];
    "deepseek.model": string;
    "deepseek.reasoningEffort": PublicConfig["deepseek"]["reasoningEffort"];
    "replyJudge.model": string;
    "replyJudge.timeoutMs": string;
    "replyJudge.fallbackToMainOnInvalidOutput": boolean;
    "replyJudge.turnWaitMs": string;
    logLevel: PublicConfig["logLevel"];
    "botLoopGuard.maxCycles": string;
}

export interface SettingsFormState {
    baseline: PublicConfig;
    values: SettingsValues;
    externalConflict: boolean;
}

const SETTINGS_FIELDS: readonly SettingsField[] = [
    "aiProvider",
    "gpt.model",
    "gpt.reasoningEffort",
    "gpt.verbosity",
    "deepseek.model",
    "deepseek.reasoningEffort",
    "replyJudge.model",
    "replyJudge.timeoutMs",
    "replyJudge.fallbackToMainOnInvalidOutput",
    "replyJudge.turnWaitMs",
    "logLevel",
    "botLoopGuard.maxCycles",
];

export function createSettingsForm(config: PublicConfig): SettingsFormState {
    return {
        baseline: config,
        values: {
            aiProvider: config.aiProvider,
            "gpt.model": config.gpt.model,
            "gpt.reasoningEffort": config.gpt.reasoningEffort,
            "gpt.verbosity": config.gpt.verbosity,
            "deepseek.model": config.deepseek.model,
            "deepseek.reasoningEffort": config.deepseek.reasoningEffort,
            "replyJudge.model": config.replyJudge.model,
            "replyJudge.timeoutMs": String(config.replyJudge.timeoutMs),
            "replyJudge.fallbackToMainOnInvalidOutput": config.replyJudge.fallbackToMainOnInvalidOutput,
            "replyJudge.turnWaitMs": String(config.replyJudge.turnWaitMs / 1_000),
            logLevel: config.logLevel,
            "botLoopGuard.maxCycles": String(config.botLoopGuard.maxCycles),
        },
        externalConflict: false,
    };
}

function baselineValue(config: PublicConfig, field: SettingsField): string {
    switch (field) {
        case "aiProvider": return config.aiProvider;
        case "gpt.model": return config.gpt.model;
        case "gpt.reasoningEffort": return config.gpt.reasoningEffort;
        case "gpt.verbosity": return config.gpt.verbosity;
        case "deepseek.model": return config.deepseek.model;
        case "deepseek.reasoningEffort": return config.deepseek.reasoningEffort;
        case "replyJudge.model": return config.replyJudge.model;
        case "replyJudge.timeoutMs": return String(config.replyJudge.timeoutMs);
        case "replyJudge.fallbackToMainOnInvalidOutput": return String(config.replyJudge.fallbackToMainOnInvalidOutput);
        case "replyJudge.turnWaitMs": return String(config.replyJudge.turnWaitMs / 1_000);
        case "logLevel": return config.logLevel;
        case "botLoopGuard.maxCycles": return String(config.botLoopGuard.maxCycles);
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

export function settingsFieldError(field: SettingsField, values: SettingsValues): string | undefined {
    const value = String(values[field]);
    if (field === "gpt.model" || field === "deepseek.model" || field === "replyJudge.model") {
        return value.trim() ? undefined : "请填写模型名称";
    }
    if (field === "replyJudge.timeoutMs" && parseTimeoutInput(value) === null) return "请输入 1000 到 30000 之间的整数毫秒";
    if (field === "replyJudge.turnWaitMs" && parseTurnWaitSecondsInput(value) === null) return "请输入 1 到 60 秒之间的值，最多精确到毫秒";
    if (field === "botLoopGuard.maxCycles" && parsePositiveInteger(value) === null) return "请输入大于等于 1 的整数";
    return undefined;
}

export function settingsPatches(form: SettingsFormState): PublicConfigPatch[] {
    return visibleDirtySettingsFields(form).flatMap((field): PublicConfigPatch[] => {
        const value = form.values[field];
        const textValue = String(value);
        switch (field) {
            case "aiProvider": return [{ field, value: value as PublicConfig["aiProvider"] }];
            case "gpt.model":
            case "deepseek.model":
            case "replyJudge.model": return [{ field, value: textValue.trim() }];
            case "gpt.reasoningEffort": return [{ field, value: value as PublicConfig["gpt"]["reasoningEffort"] }];
            case "deepseek.reasoningEffort": return [{ field, value: value as PublicConfig["deepseek"]["reasoningEffort"] }];
            case "gpt.verbosity": return [{ field, value: value as PublicConfig["gpt"]["verbosity"] }];
            case "logLevel": return [{ field, value: value as PublicConfig["logLevel"] }];
            case "replyJudge.timeoutMs": {
                const parsed = parseTimeoutInput(textValue);
                return parsed === null ? [] : [{ field, value: parsed }];
            }
            case "replyJudge.fallbackToMainOnInvalidOutput": return [{ field, value: value as boolean }];
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
}

type SettingsEditAction = {
    [Field in SettingsField]: { type: "edit"; field: Field; value: SettingsValues[Field] }
}[SettingsField];

export type SettingsFormAction =
    | { type: "server-refresh"; config: PublicConfig }
    | SettingsEditAction
    | { type: "saved"; config: PublicConfig; field: SettingsField }
    | { type: "reload"; config: PublicConfig };

function valueFromConfig(config: PublicConfig, field: SettingsField): string | boolean {
    switch (field) {
        case "aiProvider": return config.aiProvider;
        case "gpt.model": return config.gpt.model;
        case "gpt.reasoningEffort": return config.gpt.reasoningEffort;
        case "gpt.verbosity": return config.gpt.verbosity;
        case "deepseek.model": return config.deepseek.model;
        case "deepseek.reasoningEffort": return config.deepseek.reasoningEffort;
        case "replyJudge.model": return config.replyJudge.model;
        case "replyJudge.timeoutMs": return String(config.replyJudge.timeoutMs);
        case "replyJudge.fallbackToMainOnInvalidOutput": return config.replyJudge.fallbackToMainOnInvalidOutput;
        case "replyJudge.turnWaitMs": return String(config.replyJudge.turnWaitMs / 1_000);
        case "logLevel": return config.logLevel;
        case "botLoopGuard.maxCycles": return String(config.botLoopGuard.maxCycles);
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
        return {
            ...state,
            baseline: action.config,
            values: { ...state.values, [action.field]: valueFromConfig(action.config, action.field) } as SettingsValues,
            externalConflict: false,
        };
    }
    return state;
}
