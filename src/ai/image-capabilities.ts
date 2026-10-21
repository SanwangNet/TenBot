import type {
    ImageGenerationQuality,
    ImageGenerationSize,
    ImageOutputFormat,
} from "../config/config-types.js";

export interface ImageModelCapabilities {
    quality: readonly ImageGenerationQuality[];
    sizes: readonly ImageGenerationSize[];
    outputFormats: readonly ImageOutputFormat[];
    supportsAutoSize: boolean;
    supportsCustomSize: boolean;
    source: "upstream" | "openai-sdk-profile" | "conservative";
}

export interface ExplicitImageModelCapabilities {
    quality?: unknown;
    sizes?: unknown;
    outputFormats?: unknown;
    supportsAutoSize?: unknown;
}

const COMMON_SIZES = ["1024x1024", "1536x1024", "1024x1536"] as const satisfies readonly ImageGenerationSize[];
const GPT_IMAGE_2_SIZES = [...COMMON_SIZES, "2048x2048", "2048x1152", "auto"] as const satisfies readonly ImageGenerationSize[];
const GPT_IMAGE_FORMATS = ["png", "jpeg", "webp"] as const satisfies readonly ImageOutputFormat[];
const CONSERVATIVE_CAPABILITIES: ImageModelCapabilities = {
    quality: ["low"],
    sizes: ["1024x1024"],
    outputFormats: ["png"],
    supportsAutoSize: false,
    supportsCustomSize: false,
    source: "conservative",
};

const GPT_IMAGE_CAPABILITIES: ImageModelCapabilities = {
    quality: ["low", "medium", "high"],
    sizes: COMMON_SIZES,
    outputFormats: GPT_IMAGE_FORMATS,
    supportsAutoSize: false,
    supportsCustomSize: false,
    source: "openai-sdk-profile",
};

const GPT_IMAGE_2_CAPABILITIES: ImageModelCapabilities = {
    ...GPT_IMAGE_CAPABILITIES,
    sizes: GPT_IMAGE_2_SIZES,
    supportsAutoSize: true,
    supportsCustomSize: true,
};

const GPT_IMAGE_25_CAPABILITIES: ImageModelCapabilities = {
    ...GPT_IMAGE_2_CAPABILITIES,
    quality: ["low", "medium", "high", "xhigh", "max"],
};

const ALL_QUALITIES: readonly ImageGenerationQuality[] = ["low", "medium", "high", "xhigh", "max", "auto", "standard", "hd"];
const ALL_SIZES: readonly ImageGenerationSize[] = ["256x256", "512x512", "1024x1024", "1536x1024", "1024x1536", "1792x1024", "1024x1792", "2048x2048", "2048x1152", "auto"];

const DALLE_2_CAPABILITIES: ImageModelCapabilities = {
    quality: ["standard"],
    sizes: ["256x256", "512x512", "1024x1024"],
    supportsAutoSize: false,
    supportsCustomSize: false,
    // DALL-E uses response_format rather than output_format; png is the stored default.
    outputFormats: ["png"],
    source: "openai-sdk-profile",
};

const DALLE_3_CAPABILITIES: ImageModelCapabilities = {
    quality: ["standard", "hd"],
    sizes: ["1024x1024", "1792x1024", "1024x1792"],
    supportsAutoSize: false,
    supportsCustomSize: false,
    outputFormats: ["png"],
    source: "openai-sdk-profile",
};

export function isImageModelNameCandidate(modelId: string): boolean {
    return /(?:^|[-_/])image(?:[-_./0-9]|$)|(?:^|[-_/])dall[-_]?e(?:[-_.0-9]|$)/i.test(modelId);
}

/**
 * This is a parameter compatibility profile, not a capability probe. Unknown or
 * custom model IDs receive only the configuration combination verified in TenBot.
 */
export function getImageModelCapabilities(
    modelId: string,
    explicit?: ExplicitImageModelCapabilities,
): ImageModelCapabilities {
    const normalized = modelId.trim().toLowerCase();
    let profile = CONSERVATIVE_CAPABILITIES;
    if (/^gpt-image-2\.5-(?:sunburst|flare)(?:-|$)/.test(normalized)) {
        profile = GPT_IMAGE_25_CAPABILITIES;
    } else if (/^gpt-image-2(?:-|$)/.test(normalized)) {
        profile = GPT_IMAGE_2_CAPABILITIES;
    } else if (/^gpt-image-/i.test(normalized)) {
        profile = GPT_IMAGE_CAPABILITIES;
    } else if (/^dall-e-2(?:-|$)/i.test(normalized)) {
        profile = DALLE_2_CAPABILITIES;
    } else if (/^dall-e-3(?:-|$)/i.test(normalized)) {
        profile = DALLE_3_CAPABILITIES;
    }

    if (!explicit) return profile;

    const quality = explicitList(profile.quality, explicit.quality, ALL_QUALITIES);
    const sizes = explicitImageSizes(profile.sizes, explicit.sizes);
    const outputFormats = explicitList(profile.outputFormats, explicit.outputFormats, ["png", "jpeg", "webp"]);
    const supportsAutoSize = typeof explicit.supportsAutoSize === "boolean"
        ? explicit.supportsAutoSize
        : Array.isArray(explicit.sizes) ? sizes.includes("auto") : profile.supportsAutoSize;
    const sizesWithAuto = supportsAutoSize && !sizes.includes("auto") ? [...sizes, "auto"] : sizes;
    return {
        quality,
        sizes: sizesWithAuto,
        outputFormats,
        supportsAutoSize,
        supportsCustomSize: profile.supportsCustomSize,
        source: "upstream",
    };
}

export function getConservativeImageModelCapabilities(): ImageModelCapabilities {
    return CONSERVATIVE_CAPABILITIES;
}

function explicitList<T extends string>(fallback: readonly T[], input: unknown, allowed: readonly T[]): readonly T[] {
    if (!Array.isArray(input)) return fallback;
    const requested = new Set(input.filter((value): value is string => typeof value === "string"));
    return allowed.filter((value) => requested.has(value));
}

function explicitImageSizes(fallback: readonly ImageGenerationSize[], input: unknown): readonly ImageGenerationSize[] {
    if (!Array.isArray(input)) return fallback;
    const values = input.filter((value): value is string => typeof value === "string");
    return [...new Set(values.filter((value) => ALL_SIZES.includes(value as ImageGenerationSize) || parseImageDimensions(value)))];
}

export interface ImageDimensions {
    width: number;
    height: number;
}

export function parseImageDimensions(size: string): ImageDimensions | undefined {
    const match = /^([1-9]\d{0,4})x([1-9]\d{0,4})$/.exec(size);
    if (!match) return undefined;
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) return undefined;
    return { width, height };
}

/** GPT Image 2 custom size constraints from the official OpenAI Image API guide. */
export function validateGptImage2CustomSize(size: string): boolean {
    const dimensions = parseImageDimensions(size);
    if (!dimensions) return false;
    const { width, height } = dimensions;
    const pixels = width * height;
    const ratio = Math.max(width, height) / Math.min(width, height);
    return width % 16 === 0 && height % 16 === 0 && Math.max(width, height) <= 3840 &&
        ratio <= 3 && pixels >= 655_360 && pixels <= 8_294_400;
}

export function imageSizeSupportedByCapabilities(size: string, capabilities: ImageModelCapabilities): boolean {
    if (size === "auto") return capabilities.supportsAutoSize && capabilities.sizes.includes("auto");
    if (capabilities.sizes.includes(size)) return true;
    return capabilities.supportsCustomSize && validateGptImage2CustomSize(size);
}
