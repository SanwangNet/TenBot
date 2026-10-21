import OpenAI from "openai";
import {
    getConservativeImageModelCapabilities,
    getImageModelCapabilities,
    type ExplicitImageModelCapabilities,
    type ImageModelCapabilities,
} from "../../image-capabilities.js";
import { classifyGptModel, type GptModelClassificationMetadata, type GptModelSummary } from "../../model-classification.js";

export interface GptModelCatalogConfig {
    apiKey?: string;
    baseURL?: string;
}

export interface GptImageModelCandidate {
    id: string;
    evidence: "upstream" | "name";
    capabilities: ImageModelCapabilities;
}

export interface GptModelCatalog {
    models: string[];
    entries: GptModelSummary[];
    imageCandidates: GptImageModelCandidate[];
    defaultImageCapabilities: ImageModelCapabilities;
}

/** Reads safe model IDs and optional image metadata from the configured upstream. */
export async function listGptModelCatalog(config: GptModelCatalogConfig): Promise<GptModelCatalog> {
    const apiKey = config.apiKey?.trim();
    const baseURL = config.baseURL?.trim();
    if (!apiKey || !baseURL) throw new Error("GPT credentials are not configured");

    const client = new OpenAI({ apiKey, baseURL, timeout: 15_000, maxRetries: 0 });
    const models = new Map<string, {
        id: string;
        explicit?: ExplicitImageModelCapabilities;
        imageSupport?: boolean;
        classificationMetadata: GptModelClassificationMetadata;
    }>();
    for await (const model of client.models.list()) {
        if (typeof model.id === "string" && model.id.trim() && model.id.length <= 128 && !/[\u0000-\u001f\u007f]/.test(model.id)) {
            const record = model as unknown as Record<string, unknown>;
            const imageMetadata = extractImageMetadata(record);
            models.set(model.id, { id: model.id, ...imageMetadata });
        }
    }

    const orderedModels = [...models.values()].sort((left, right) => left.id.localeCompare(right.id));
    const entries = orderedModels.map((entry) => classifyGptModel(entry.id, entry.classificationMetadata));
    const imageCandidates: GptImageModelCandidate[] = orderedModels.flatMap((entry) => {
        if (entry.imageSupport === false) return [];
        const classified = classifyGptModel(entry.id, entry.classificationMetadata);
        if (classified.category !== "image") return [];
        const evidence = entry.imageSupport === true || classified.classificationSource === "provider" ? "upstream" : "name";
        return [{
            id: entry.id,
            evidence,
            capabilities: getImageModelCapabilities(entry.id, entry.explicit),
        }];
    });

    return {
        models: entries.map((entry) => entry.id),
        entries,
        imageCandidates,
        defaultImageCapabilities: getConservativeImageModelCapabilities(),
    };
}

/** Compatibility helper for call sites that only need IDs. */
export async function listGptModelIds(config: GptModelCatalogConfig): Promise<string[]> {
    return (await listGptModelCatalog(config)).models;
}

function extractImageMetadata(record: Record<string, unknown>): {
    explicit?: ExplicitImageModelCapabilities;
    imageSupport?: boolean;
    classificationMetadata: GptModelClassificationMetadata;
} {
    const capabilities = asRecord(record.capabilities);
    const modelType = record.model_type ?? record.modelType ?? record.type;
    const imageFeature = record.image_generation ?? record.imageGeneration ?? capabilities?.image_generation ?? capabilities?.imageGeneration ?? capabilities?.images;
    const classificationMetadata: GptModelClassificationMetadata = {
        modelType,
        imageGeneration: imageFeature,
        capabilities,
    };
    if (imageFeature === false) return { imageSupport: false, classificationMetadata };
    if (imageFeature !== true && typeof imageFeature !== "object") return { classificationMetadata };

    const values = asRecord(imageFeature) ?? capabilities ?? record;
    const parameters = asRecord(values.image_parameters ?? values.image_generation_parameters) ?? values;
    const quality = parameters.quality ?? parameters.qualities;
    const sizes = parameters.sizes ?? parameters.size;
    const outputFormats = parameters.output_formats ?? parameters.outputFormats ?? parameters.formats;
    const supportsAutoSize = parameters.supports_auto_size ?? parameters.supportsAutoSize;
    const hasExplicitParameters = Array.isArray(quality) || Array.isArray(sizes) || Array.isArray(outputFormats) || typeof supportsAutoSize === "boolean";
    return {
        imageSupport: true,
        classificationMetadata,
        ...(hasExplicitParameters ? { explicit: { quality, sizes, outputFormats, supportsAutoSize } } : {}),
    };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}
