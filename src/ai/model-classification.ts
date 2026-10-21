import { isImageModelNameCandidate } from "./image-capabilities.js";

export type GptModelCategory = "chat" | "image" | "specialized" | "other" | "unknown";
export type GptModelClassificationSource = "provider" | "known" | "inferred" | "unknown";
export type GptModelCapabilityTag =
    | "chat"
    | "reasoning"
    | "coding"
    | "image-generation"
    | "compaction"
    | "code-review"
    | "embedding"
    | "audio"
    | "video"
    | "moderation";

export interface GptModelSummary {
    id: string;
    displayName: string;
    category: GptModelCategory;
    capabilityTags: GptModelCapabilityTag[];
    classificationSource: GptModelClassificationSource;
}

export interface GptModelClassificationMetadata {
    modelType?: unknown;
    imageGeneration?: unknown;
    capabilities?: Record<string, unknown>;
}

export type GptModelPurpose = "chat" | "image";

export interface GptModelPickerEntries {
    recommended: GptModelSummary[];
    preservedCurrent?: GptModelSummary;
    currentIsListed: boolean;
}

const MODEL_CATEGORY_LABELS: Record<GptModelCategory, string> = {
    chat: "聊天 / 推理 / 编程",
    image: "图像生成候选",
    specialized: "专用工具",
    other: "其他能力",
    unknown: "未知类型",
};

const MODEL_SOURCE_LABELS: Record<GptModelClassificationSource, string> = {
    provider: "上游元数据",
    known: "已知模型族",
    inferred: "名称推断",
    unknown: "未识别",
};

/** Classifies a model for display only; inferred names are not capability validation. */
export function classifyGptModel(id: string, metadata: GptModelClassificationMetadata = {}): GptModelSummary {
    const providerResult = classifyProviderMetadata(metadata);
    if (providerResult) return summary(id, providerResult.category, providerResult.capabilityTags, "provider");

    const normalized = id.toLowerCase();
    const imageWasExplicitlyDisabled = metadata.imageGeneration === false || metadata.capabilities?.image_generation === false || metadata.capabilities?.imageGeneration === false;

    if (imageWasExplicitlyDisabled && isImageModelNameCandidate(normalized)) {
        return summary(id, "unknown", [], "unknown");
    }
    if (isImageModelNameCandidate(normalized)) {
        return summary(id, "image", ["image-generation"], "known");
    }

    if (/(?:^|[-_.])(?:compaction|compact|context[-_.]?compress(?:ion)?|compress(?:ion)?|code[-_.]?review|review|reviewer|review[-_.]?model)(?:[-_.]|$)/i.test(normalized)) {
        const tags: GptModelCapabilityTag[] = [];
        if (/(?:compaction|compact|context[-_.]?compress|compress)/i.test(normalized)) tags.push("compaction");
        if (/(?:code[-_.]?review|review|reviewer|review[-_.]?model)/i.test(normalized)) tags.push("code-review");
        return summary(id, "specialized", tags.length ? tags : ["code-review"], "known");
    }

    const otherTag = classifyOtherModelName(normalized);
    if (otherTag) return summary(id, "other", [otherTag], "known");

    if (/^(?:gpt-|o[134](?:[-.]|$)|chatgpt-)/i.test(normalized)) {
        const tags: GptModelCapabilityTag[] = ["chat"];
        if (/^o[134](?:[-.]|$)/i.test(normalized) || /(?:^|[-_.])reasoning(?:[-_.]|$)/i.test(normalized)) tags.push("reasoning");
        if (/(?:^|[-_.])(?:codex|coder|coding|code)(?:[-_.]|$)/i.test(normalized)) tags.push("coding");
        return summary(id, "chat", tags, "known");
    }

    if (/(?:^|[-_.])(?:chat|instruct|instruction|coder|coding|reasoning|thinking)(?:[-_.]|$)/i.test(normalized)) {
        const tags: GptModelCapabilityTag[] = ["chat"];
        if (/(?:^|[-_.])(?:coder|coding)(?:[-_.]|$)/i.test(normalized)) tags.push("coding");
        if (/(?:^|[-_.])(?:reasoning|thinking)(?:[-_.]|$)/i.test(normalized)) tags.push("reasoning");
        return summary(id, "chat", tags, "inferred");
    }

    return summary(id, "unknown", [], "unknown");
}

/** Default picker filtering. Enabling `includeOtherTypes` displays every listed category. */
export function filterGptModelsForPurpose(
    models: readonly GptModelSummary[],
    purpose: GptModelPurpose,
    includeOtherTypes = false,
): GptModelSummary[] {
    return includeOtherTypes ? [...models] : models.filter((model) => model.category === purpose);
}

/** Keeps a saved model visible when its category is filtered from the default options. */
export function getGptModelPickerEntries(
    models: readonly GptModelSummary[],
    purpose: GptModelPurpose,
    currentModelId: string,
    includeOtherTypes = false,
): GptModelPickerEntries {
    const recommended = filterGptModelsForPurpose(models, purpose, includeOtherTypes);
    const currentModel = models.find((model) => model.id === currentModelId);
    const isRecommended = recommended.some((model) => model.id === currentModelId);
    return {
        recommended,
        ...(currentModel && !isRecommended ? { preservedCurrent: currentModel } : {}),
        currentIsListed: Boolean(currentModel),
    };
}

export function gptModelCategoryLabel(category: GptModelCategory): string {
    return MODEL_CATEGORY_LABELS[category];
}

export function gptModelClassificationLabel(source: GptModelClassificationSource): string {
    return MODEL_SOURCE_LABELS[source];
}

export function gptModelOptionLabel(model: GptModelSummary): string {
    const evidence = model.classificationSource === "known" || model.classificationSource === "inferred"
        ? `，${gptModelClassificationLabel(model.classificationSource)}`
        : "";
    return `${model.displayName}（${gptModelCategoryLabel(model.category)}${evidence}）`;
}

function summary(
    id: string,
    category: GptModelCategory,
    capabilityTags: GptModelCapabilityTag[],
    classificationSource: GptModelClassificationSource,
): GptModelSummary {
    return { id, displayName: id, category, capabilityTags, classificationSource };
}

function classifyProviderMetadata(metadata: GptModelClassificationMetadata): {
    category: GptModelCategory;
    capabilityTags: GptModelCapabilityTag[];
} | undefined {
    const modelType = typeof metadata.modelType === "string" ? normalizeType(metadata.modelType) : "";
    const typeCategory = categoryForProviderType(modelType);
    const tags = providerCapabilityTags(metadata);

    if (tags.length === 0) {
        return typeCategory ? { category: typeCategory, capabilityTags: tagsForCategory(typeCategory) } : undefined;
    }

    // Explicit task capabilities are more specific than general chat support.
    const category = tags.includes("compaction") || tags.includes("code-review") ? "specialized"
        : tags.includes("embedding") || tags.includes("audio") || tags.includes("video") || tags.includes("moderation") ? "other"
            : tags.includes("image-generation") ? "image"
                : tags.includes("chat") ? "chat"
                    : undefined;
    return category ? { category, capabilityTags: tags } : undefined;
}

function providerCapabilityTags(metadata: GptModelClassificationMetadata): GptModelCapabilityTag[] {
    const tags = new Set<GptModelCapabilityTag>();
    if (metadata.imageGeneration === true || (metadata.imageGeneration !== null && typeof metadata.imageGeneration === "object")) {
        tags.add("image-generation");
    }
    const capabilities = metadata.capabilities ?? {};
    const trueValue = (value: unknown) => value === true || (value !== null && typeof value === "object");
    const add = (keys: readonly string[], tag: GptModelCapabilityTag) => {
        if (keys.some((key) => trueValue(capabilities[key]))) tags.add(tag);
    };

    add(["chat", "chat_completion", "chat_completions", "text_generation", "completions"], "chat");
    add(["image_generation", "imageGeneration"], "image-generation");
    add(["compaction", "context_compaction", "contextCompaction"], "compaction");
    add(["code_review", "codeReview"], "code-review");
    add(["embedding", "embeddings"], "embedding");
    add(["audio", "speech", "transcription"], "audio");
    add(["video"], "video");
    add(["moderation", "moderations"], "moderation");

    const listed = capabilities.features;
    if (Array.isArray(listed)) {
        for (const feature of listed) {
            if (typeof feature !== "string") continue;
            const category = categoryForProviderType(normalizeType(feature));
            if (category) for (const tag of tagsForCategory(category)) tags.add(tag);
        }
    }
    return [...tags];
}

function categoryForProviderType(type: string): GptModelCategory | undefined {
    if (["image", "image_generation", "image_generation_model"].includes(type)) return "image";
    if (["compaction", "context_compaction", "code_review", "review", "specialized"].includes(type)) return "specialized";
    if (["embedding", "embeddings", "audio", "speech", "transcription", "video", "moderation"].includes(type)) return "other";
    if (["chat", "text", "text_generation", "chat_completion", "completion", "language_model"].includes(type)) return "chat";
    return undefined;
}

function tagsForCategory(category: GptModelCategory): GptModelCapabilityTag[] {
    switch (category) {
        case "chat": return ["chat"];
        case "image": return ["image-generation"];
        case "specialized": return [];
        case "other": return [];
        case "unknown": return [];
    }
}

function classifyOtherModelName(id: string): GptModelCapabilityTag | undefined {
    if (/(?:^|[-_.])(?:embedding|embeddings|embed)(?:[-_.]|$)/i.test(id)) return "embedding";
    if (/(?:^|[-_.])(?:audio|speech|tts|transcribe|transcription|whisper)(?:[-_.]|$)/i.test(id)) return "audio";
    if (/(?:^|[-_.])(?:video|sora)(?:[-_.]|$)/i.test(id)) return "video";
    if (/(?:^|[-_.])(?:moderation|moderations)(?:[-_.]|$)/i.test(id)) return "moderation";
    return undefined;
}

function normalizeType(value: string): string {
    return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}
