import OpenAI from "openai";
import type { ImageGenerateParamsNonStreaming, ImagesResponse } from "openai/resources/images.js";
import sharp from "sharp";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, join } from "node:path";

import { imageSizeSupportedByCapabilities, parseImageDimensions, type ImageDimensions } from "./image-capabilities.js";
import { validateImageGenerationConfig } from "../config/config-validation.js";
import type { AppConfig, ImageGenerationConfig, ImageOutputFormat } from "../config/config-types.js";
import { TenBotError } from "../errors/tenbot-error.js";
import { findExplicitHttpStatus, mapConfirmedRemoteHttpError } from "../errors/http-mapping.js";
import { logger } from "../shared/logger.js";
import type {
    ImageGenerationArtifact,
    ImageGenerationRequestStatus,
    ImageGenerationSendStatus,
    ImageGenerationUsage,
    MemberRepository,
} from "../members/repository.js";
import { IMAGE_GENERATION_LIMITS } from "../skills/image/limits.js";

export const DEFAULT_GENERATED_IMAGE_DIRECTORY = resolve(process.cwd(), "data", "sandbox", "files", "img");

export interface ImageGenerationApi {
    images: {
        generate(body: ImageGenerateParamsNonStreaming, options?: {
            signal?: AbortSignal;
            maxRetries?: number;
            timeout?: number;
        }): Promise<ImagesResponse>;
    };
}

export interface ImageGenerationServiceOptions {
    getConfig(): AppConfig;
    repository: MemberRepository;
    validateConfig?: (config: ImageGenerationConfig) => void;
    createClient?: (apiKey: string, baseURL: string) => ImageGenerationApi;
    now?: () => number;
    imageDirectory?: string;
    limits?: Partial<Record<keyof typeof IMAGE_GENERATION_LIMITS, number>>;
}

export interface ImageGenerationInput {
    prompt: string;
    groupOpenid?: string;
    memberOpenid?: string;
    messageId?: string;
    signal?: AbortSignal;
}

export interface GeneratedImage {
    localPath: string;
    requestId: string;
    requestKey: string;
    model: string;
    requestedSize: string;
    actualSize: string;
    quality: string;
    outputFormat: ImageOutputFormat;
    actualFormat: ImageOutputFormat;
    usage?: ImageGenerationUsage;
    complete(status: Extract<ImageGenerationSendStatus, "quoted" | "unquoted" | "failed" | "unknown">): Promise<void>;
    /** Removes only unfinished write resources. The generated artifact is permanent. */
    cleanup(): Promise<void>;
}

export interface ImageGenerationErrorDetails {
    requestedSize?: string;
    actualSize?: string;
}

const defaultClient = (apiKey: string, baseURL: string): ImageGenerationApi =>
    new OpenAI({ apiKey, baseURL, maxRetries: 0 }) as unknown as ImageGenerationApi;

interface DecodedImage {
    bytes: Buffer;
    dimensions: ImageDimensions;
    format: ImageOutputFormat;
}

interface ImageRequestMetadata {
    requestId: string;
    createdAt: string;
    groupId: string;
    memberId: string;
    prompt: string;
    model: string;
    requestedSize: string;
    actualSize: string;
    quality: string;
    outputFormat: ImageOutputFormat;
    actualFormat: ImageOutputFormat;
    usage: ImageGenerationUsage | null;
    generationStatus: "succeeded" | "size_mismatch";
    sendStatus: ImageGenerationSendStatus;
}

export class ImageGenerationError extends TenBotError {
    readonly details?: ImageGenerationErrorDetails;

    constructor(code: ConstructorParameters<typeof TenBotError>[0], cause?: unknown, details?: ImageGenerationErrorDetails) {
        super(code, cause === undefined ? {} : { cause });
        this.name = "ImageGenerationError";
        this.details = details;
    }
}

function finiteCount(value: unknown): number | undefined {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function readUsage(response: ImagesResponse): ImageGenerationUsage | undefined {
    const usage = response.usage;
    if (!usage) return undefined;
    const inputTokens = finiteCount(usage.input_tokens);
    const outputTokens = finiteCount(usage.output_tokens);
    const totalTokens = finiteCount(usage.total_tokens);
    const inputImageTokens = finiteCount(usage.input_tokens_details?.image_tokens);
    const outputImageTokens = finiteCount(usage.output_tokens_details?.image_tokens);
    const textTokens = finiteCount(usage.input_tokens_details?.text_tokens);
    const imageTokens = inputImageTokens === undefined && outputImageTokens === undefined
        ? undefined : (inputImageTokens ?? 0) + (outputImageTokens ?? 0);
    const normalized = { inputTokens, outputTokens, totalTokens, imageTokens, textTokens };
    return Object.values(normalized).some((value) => value !== undefined) ? normalized : undefined;
}

function sniffFormat(bytes: Buffer): ImageOutputFormat | undefined {
    if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png";
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
    if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "webp";
    return undefined;
}

async function decodeImage(base64: string | undefined, maxBytes: number, maxPixels: number, maxEdge: number): Promise<DecodedImage> {
    if (!base64 || base64.length > Math.ceil(maxBytes * 4 / 3) + 4 || base64.length % 4 !== 0 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
        throw new ImageGenerationError("M:A_IG_IRS");
    }
    const bytes = Buffer.from(base64, "base64");
    const format = sniffFormat(bytes);
    if (!bytes.length || bytes.length > maxBytes || !format) throw new ImageGenerationError("M:A_IG_IRS");
    try {
        const metadata = await sharp(bytes, { limitInputPixels: maxPixels }).metadata();
        const width = metadata.width;
        const height = metadata.height;
        const actualFormat = metadata.format;
        if (actualFormat !== format || !width || !height || width * height > maxPixels || Math.max(width, height) > maxEdge) {
            throw new ImageGenerationError("M:A_IG_IRS");
        }
        return { bytes, format, dimensions: { width, height } };
    } catch (error) {
        if (error instanceof ImageGenerationError) throw error;
        throw new ImageGenerationError("M:A_IG_IRS", error);
    }
}

function explicitRemoteMessage(error: unknown): string {
    const seen = new Set<object>();
    const queue: unknown[] = [error];
    const pieces: string[] = [];
    while (queue.length && seen.size < 8) {
        const value = queue.shift();
        if (!value || typeof value !== "object" || seen.has(value)) continue;
        seen.add(value);
        const fields = value as Record<string, unknown>;
        for (const key of ["message", "param", "code", "type"] as const) {
            if (typeof fields[key] === "string") pieces.push(fields[key] as string);
        }
        for (const key of ["cause", "error", "body", "response"] as const) {
            if (fields[key] !== undefined) queue.push(fields[key]);
        }
    }
    return pieces.join(" ").toLowerCase();
}

function providerError(error: unknown, wasTimedOut: boolean, requestedSize: string): ImageGenerationError {
    if (error instanceof ImageGenerationError) return error;
    const status = findExplicitHttpStatus(error);
    if (wasTimedOut || status === undefined) return new ImageGenerationError("R:A_MP_TMO", error);
    if (status === 401 || status === 403) return new ImageGenerationError("R:A_MP_AUF", error);
    if (status === 429) return new ImageGenerationError("R:C_MP_RAT", error);
    if ((status === 400 || status === 422) && /size|resolution|dimension|pixel|aspect ratio/.test(explicitRemoteMessage(error))) {
        return new ImageGenerationError("R:C_MP_SIZ", error, { requestedSize });
    }
    if (status === 400 || status === 422) return new ImageGenerationError("R:C_MP_PAR", error);
    return new ImageGenerationError(mapConfirmedRemoteHttpError("MP", status) ?? "R:A_MP_REQ", error);
}

function utcDayKey(at: number): string {
    return new Date(at).toISOString().slice(0, 10);
}

function isDallEModel(model: string): boolean {
    return /^dall-e-[23](?:-|$)/i.test(model.trim());
}

function maximumPromptLength(model: string, configuredLimit: number): number {
    if (/^dall-e-2(?:-|$)/i.test(model.trim())) return Math.min(configuredLimit, 1_000);
    if (/^dall-e-3(?:-|$)/i.test(model.trim())) return Math.min(configuredLimit, 4_000);
    return configuredLimit;
}

function requestBody(config: AppConfig, prompt: string, imagesPerRequest: number): ImageGenerateParamsNonStreaming {
    const image = config.image;
    return {
        model: image.model,
        prompt,
        n: imagesPerRequest,
        size: image.size,
        quality: image.quality,
        ...(isDallEModel(image.model)
            ? { response_format: "b64_json" as const }
            : { output_format: image.outputFormat }),
    };
}

async function writeRequestJson(directory: string, metadata: ImageRequestMetadata): Promise<void> {
    const temporaryPath = join(directory, `.request-${randomUUID()}.tmp`);
    try {
        await writeFile(temporaryPath, JSON.stringify(metadata, null, 2), { flag: "wx", mode: 0o600 });
        await rename(temporaryPath, join(directory, "request.json"));
    } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
    }
}

function toArtifactRecord(metadata: ImageRequestMetadata, imagePath: string, updatedAt: number): ImageGenerationArtifact {
    return {
        requestId: metadata.requestId,
        prompt: metadata.prompt,
        actualSize: metadata.actualSize,
        actualFormat: metadata.actualFormat,
        imagePath,
        generationStatus: metadata.generationStatus,
        sendStatus: metadata.sendStatus,
        updatedAt,
    };
}

export class ImageGenerationService {
    private readonly createClient: (apiKey: string, baseURL: string) => ImageGenerationApi;
    private readonly now: () => number;
    private readonly imageDirectory: string;
    private readonly limits: Record<keyof typeof IMAGE_GENERATION_LIMITS, number>;
    private readonly controllers = new Set<AbortController>();
    private readonly operations = new Set<Promise<GeneratedImage>>();
    private readonly leases = new Map<string, GeneratedImage>();
    private stopping = false;

    constructor(private readonly options: ImageGenerationServiceOptions) {
        this.createClient = options.createClient ?? defaultClient;
        this.now = options.now ?? Date.now;
        this.imageDirectory = options.imageDirectory ?? DEFAULT_GENERATED_IMAGE_DIRECTORY;
        this.limits = { ...IMAGE_GENERATION_LIMITS, ...options.limits };
    }

    isEnabled(): boolean {
        try { return this.options.getConfig().image.enabled; }
        catch { return false; }
    }

    generate(input: ImageGenerationInput): Promise<GeneratedImage> {
        if (this.stopping) return Promise.reject(new ImageGenerationError("M:C_IG_CAN"));
        const operation = this.generateInternal(input);
        this.operations.add(operation);
        void operation.finally(() => this.operations.delete(operation)).catch(() => undefined);
        return operation;
    }

    async finish(image: GeneratedImage, status: Extract<ImageGenerationSendStatus, "quoted" | "unquoted" | "failed" | "unknown">): Promise<void> {
        try { await image.complete(status); }
        finally { await image.cleanup(); }
    }

    async recoverPendingRequests(): Promise<void> {
        const before = await this.options.repository.listImageGenerationUsage({ limit: 500 });
        await this.options.repository.recoverPendingImageGenerationRequests(this.now());
        const after = await this.options.repository.listImageGenerationUsage({ limit: 500 });
        const pendingIds = new Set(before.filter((row) => row.sendStatus === "pending" && row.requestId).map((row) => row.requestKey));
        for (const row of after) {
            if (!pendingIds.has(row.requestKey) || row.sendStatus !== "unknown" || !row.requestId || !row.actualSize || !row.actualFormat || !row.imagePath) continue;
            const directory = join(this.imageDirectory, row.requestId);
            const directoryIdIsGeneratedUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(row.requestId);
            const directoryRelativePath = relative(resolve(this.imageDirectory), resolve(directory));
            if (!directoryIdIsGeneratedUuid || directoryRelativePath.startsWith("..") || isAbsolute(directoryRelativePath)) continue;
            const metadata: ImageRequestMetadata = {
                requestId: row.requestId,
                createdAt: new Date(row.requestedAt).toISOString(),
                groupId: row.groupOpenid,
                memberId: row.memberOpenid,
                prompt: row.prompt ?? "",
                model: row.model,
                requestedSize: row.size,
                actualSize: row.actualSize,
                quality: row.quality,
                outputFormat: row.outputFormat as ImageOutputFormat,
                actualFormat: row.actualFormat as ImageOutputFormat,
                usage: this.usageOf(row) ?? null,
                generationStatus: row.generationStatus ?? "succeeded",
                sendStatus: "unknown",
            };
            try { await writeRequestJson(directory, metadata); }
            catch { logger.error("[Image] recovered request metadata update failed"); }
        }
    }

    async shutdown(): Promise<void> {
        if (this.stopping) return;
        this.stopping = true;
        for (const controller of this.controllers) controller.abort();
        await Promise.allSettled([...this.operations]);
        await Promise.all([...this.leases.values()].map(async (image) => {
            try { await image.complete("unknown"); } catch { /* Keep shutdown moving; the DB close follows. */ }
            try { await image.cleanup(); } catch { /* Keep shutdown moving. */ }
        }));
    }

    private usageOf(row: Awaited<ReturnType<MemberRepository["listImageGenerationUsage"]>>[number]): ImageGenerationUsage | undefined {
        const usage = {
            inputTokens: row.inputTokens, outputTokens: row.outputTokens, totalTokens: row.totalTokens,
            imageTokens: row.imageTokens, textTokens: row.textTokens,
        };
        return Object.values(usage).some((value) => value !== undefined) ? usage : undefined;
    }

    private async generateInternal(input: ImageGenerationInput): Promise<GeneratedImage> {
        const prompt = input.prompt.trim();
        if (!prompt) throw new ImageGenerationError("M:C_IG_EPR");
        if (!input.memberOpenid || !input.messageId) throw new ImageGenerationError("M:C_IG_IDN");
        let config: AppConfig;
        try { config = this.options.getConfig(); }
        catch (error) { throw new ImageGenerationError("M:A_IG_CFG", error); }
        if (!config.image.enabled) throw new ImageGenerationError("M:C_IG_DSB");
        if (prompt.length > maximumPromptLength(config.image.model, this.limits.maxPromptCharacters)) {
            throw new ImageGenerationError("M:C_IG_EPR");
        }
        if (!config.image.model.trim() || !config.ai.gpt.apiKey || !config.ai.gpt.baseURL) {
            throw new ImageGenerationError("M:A_IG_CFG");
        }
        try { (this.options.validateConfig ?? validateImageGenerationConfig)(config.image); }
        catch (error) { throw new ImageGenerationError("M:A_IG_CFG", error); }
        const scope = input.groupOpenid || "__private__";
        const requestedAt = this.now();
        const requestKey = createHash("sha256").update(`${scope}\0${input.messageId}`).digest("hex");
        let reserved: Awaited<ReturnType<MemberRepository["reserveImageGenerationRequest"]>>;
        try {
            reserved = await this.options.repository.reserveImageGenerationRequest({
                requestKey, groupOpenid: scope, memberOpenid: input.memberOpenid, messageId: input.messageId,
                dayKey: utcDayKey(requestedAt), model: config.image.model, size: config.image.size,
                quality: config.image.quality, outputFormat: config.image.outputFormat, requestedAt,
                dailyLimit: this.limits.perMemberPerGroupDaily, globalConcurrency: this.limits.globalConcurrency,
            });
        } catch (error) { throw new ImageGenerationError("M:A_IG_STO", error); }
        if (reserved.kind !== "reserved") {
            const code = reserved.kind === "duplicate" ? "M:C_IG_DUP"
                : reserved.kind === "daily_limit" ? "M:C_IG_DQL"
                : reserved.kind === "member_busy" ? "M:C_IG_BSY" : "M:C_IG_GBL";
            throw new ImageGenerationError(code);
        }

        const controller = new AbortController();
        this.controllers.add(controller);
        const abortFromCaller = () => controller.abort(input.signal?.reason);
        if (input.signal?.aborted) abortFromCaller();
        else input.signal?.addEventListener("abort", abortFromCaller, { once: true });
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.limits.requestTimeoutMs);
        timer.unref?.();
        let submitted = false;
        let usage: ImageGenerationUsage | undefined;
        let requestDirectory: string | undefined;
        let temporaryImagePath: string | undefined;
        let finalImagePath: string | undefined;
        let imagePersisted = false;
        try {
            if (controller.signal.aborted || this.stopping) throw new ImageGenerationError("M:C_IG_CAN");
            if (!await this.options.repository.markImageGenerationSubmitted(requestKey, this.now())) {
                throw new ImageGenerationError("M:C_IG_CAN");
            }
            submitted = true;
            const response = await this.createClient(config.ai.gpt.apiKey, config.ai.gpt.baseURL)
                .images.generate(requestBody(config, prompt, this.limits.imagesPerRequest), {
                    signal: controller.signal, maxRetries: 0, timeout: this.limits.requestTimeoutMs,
                });
            usage = readUsage(response);
            const image = response.data?.length === 1 ? response.data[0] : undefined;
            const decoded = await decodeImage(image?.b64_json, this.limits.maxImageBytes,
                this.limits.maxImagePixels, this.limits.maxImageEdge);
            const actualSize = `${decoded.dimensions.width}x${decoded.dimensions.height}`;
            const expectedDimensions = config.image.size === "auto" ? undefined : parseImageDimensions(config.image.size);
            const hasSizeMismatch = Boolean(expectedDimensions &&
                (expectedDimensions.width !== decoded.dimensions.width || expectedDimensions.height !== decoded.dimensions.height));
            const generationStatus = hasSizeMismatch ? "size_mismatch" : "succeeded";
            const sendStatus: ImageGenerationSendStatus = hasSizeMismatch ? "not_attempted" : "pending";
            const requestId = randomUUID();
            const createdAt = new Date(requestedAt).toISOString();
            const extension = decoded.format === "jpeg" ? "jpg" : decoded.format;
            requestDirectory = join(this.imageDirectory, requestId);
            await mkdir(this.imageDirectory, { recursive: true, mode: 0o700 });
            await mkdir(requestDirectory, { recursive: false, mode: 0o700 });
            temporaryImagePath = join(requestDirectory, `.image-${randomUUID()}.tmp`);
            finalImagePath = join(requestDirectory, `image.${extension}`);
            try {
                await writeFile(temporaryImagePath, decoded.bytes, { flag: "wx", mode: 0o600 });
                await rename(temporaryImagePath, finalImagePath);
                temporaryImagePath = undefined;
                imagePersisted = true;
            } catch (error) {
                throw new ImageGenerationError("M:A_IG_TFW", error);
            }

            const metadata: ImageRequestMetadata = {
                requestId, createdAt, groupId: scope, memberId: input.memberOpenid, prompt,
                model: config.image.model, requestedSize: config.image.size, actualSize,
                quality: config.image.quality, outputFormat: config.image.outputFormat,
                actualFormat: decoded.format, usage: usage ?? null, generationStatus, sendStatus,
            };
            try { await writeRequestJson(requestDirectory, metadata); }
            catch (error) { throw new ImageGenerationError("M:A_IG_TFW", error); }
            const artifact = toArtifactRecord(metadata, finalImagePath, this.now());
            try {
                await this.options.repository.recordImageGenerationResult(requestKey,
                    hasSizeMismatch ? "failed" : "generated", usage, this.now(), artifact);
            } catch (error) {
                throw new ImageGenerationError("M:A_IG_STO", error);
            }
            if (hasSizeMismatch) {
                throw new ImageGenerationError("M:C_IG_SZM", undefined, {
                    requestedSize: config.image.size,
                    actualSize,
                });
            }

            let completed = false;
            let cleaned = false;
            const imagePath = finalImagePath;
            const imageDirectory = requestDirectory;
            const generated: GeneratedImage = {
                localPath: imagePath, requestId, requestKey, model: config.image.model,
                requestedSize: config.image.size, actualSize, quality: config.image.quality,
                outputFormat: config.image.outputFormat, actualFormat: decoded.format, usage,
                async complete(status) {
                    if (completed) return;
                    const currentMetadata = { ...metadata, sendStatus: status };
                    await writeRequestJson(imageDirectory, currentMetadata);
                    const terminalStatus: Extract<ImageGenerationRequestStatus, "succeeded" | "send_failed"> =
                        status === "quoted" || status === "unquoted" ? "succeeded" : "send_failed";
                    await thisService.options.repository.finishImageGenerationRequest(requestKey,
                        terminalStatus, thisService.now(), status);
                    completed = true;
                    if (cleaned) thisService.leases.delete(requestKey);
                },
                async cleanup() {
                    if (cleaned) return;
                    if (temporaryImagePath) await rm(temporaryImagePath, { force: true });
                    cleaned = true;
                    if (completed) thisService.leases.delete(requestKey);
                },
            };
            const thisService = this;
            this.leases.set(requestKey, generated);
            logger.info(`[Image] generated request=${requestId} model=${config.image.model} requested=${config.image.size} actual=${actualSize}` +
                ` quality=${config.image.quality} format=${decoded.format} usage=${usage ? JSON.stringify(usage) : "unavailable"}`);
            return generated;
        } catch (error) {
            if (temporaryImagePath) {
                try { await rm(temporaryImagePath, { force: true }); }
                catch { logger.error("[Image] incomplete image cleanup failed"); }
            }
            if (requestDirectory && !imagePersisted) {
                try { await rm(requestDirectory, { recursive: true, force: true }); }
                catch { logger.error("[Image] incomplete request directory cleanup failed"); }
            }
            if (submitted) {
                const status = controller.signal.aborted || timedOut ? "unknown" : "failed";
                try { await this.options.repository.recordImageGenerationResult(requestKey, status, usage, this.now()); }
                catch { logger.error("[Image] usage record update failed"); }
            } else {
                try { await this.options.repository.recordImageGenerationResult(requestKey, "failed", undefined, this.now()); }
                catch { /* Reservation recovery on restart will release it. */ }
            }
            if (error instanceof ImageGenerationError) throw error;
            if (!submitted) throw new ImageGenerationError("M:A_IG_STO", error);
            if (this.stopping && controller.signal.aborted && !timedOut) throw new ImageGenerationError("M:C_IG_CAN");
            throw providerError(error, timedOut || controller.signal.aborted, config.image.size);
        } finally {
            clearTimeout(timer);
            input.signal?.removeEventListener("abort", abortFromCaller);
            this.controllers.delete(controller);
        }
    }
}

export function createImageGenerationService(options: ImageGenerationServiceOptions): ImageGenerationService {
    return new ImageGenerationService(options);
}
