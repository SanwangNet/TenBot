import { getModelRuntimeSnapshot, type ModelRuntimeSnapshot } from "./model-registry.js";
import type { ModelPlugin } from "./model-plugin.js";
import { getPromptStore, type PromptProvider } from "./prompt-store.js";

export interface AttemptPromptSnapshot {
    readonly provider: string;
    readonly content: string;
    readonly revision: number;
    readonly loadedAt: string;
}

export interface AttemptRuntimeSnapshot {
    readonly model: ModelRuntimeSnapshot;
    readonly prompt: AttemptPromptSnapshot;
}

/** Capture both replaceable pointers synchronously at the Attempt boundary. */
export function captureAttemptRuntimeSnapshot(modelOverride?: ModelPlugin): AttemptRuntimeSnapshot {
    const activeModel = getModelRuntimeSnapshot();
    const model = modelOverride && modelOverride !== activeModel.model
        ? Object.freeze({ ...activeModel, provider: modelOverride.id, model: modelOverride })
        : activeModel;
    const prompt = getPromptStore().getForModel(model.model.id as PromptProvider);
    return Object.freeze({
        model,
        prompt: prompt ?? Object.freeze({
            provider: model.model.id,
            content: "",
            revision: 0,
            loadedAt: "",
        }),
    });
}
