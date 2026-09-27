import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import sharp from "sharp";
import type { MemeFile } from "./library-service.js";
import type { Metadata } from "sharp";

export interface MemeSendDimensions {
    width: number;
    height: number;
}

export interface PreparedMemeImage {
    localPath: string;
    original: MemeSendDimensions;
    target: MemeSendDimensions;
    resized: boolean;
    cleanup(): Promise<void>;
}

export interface MemeSendImagePreparer {
    prepare(file: MemeFile, maxEdge: number | null): Promise<PreparedMemeImage>;
}

export function computeMemeSendDimensions(width: number, height: number, maxEdge: number | null): MemeSendDimensions {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
        throw new Error("invalid image dimensions");
    }
    if (maxEdge === null || Math.max(width, height) <= maxEdge) return { width, height };
    const scale = maxEdge / Math.max(width, height);
    return {
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
    };
}

function frameDimensions(metadata: Metadata): MemeSendDimensions {
    const width = metadata.width;
    const height = metadata.pageHeight ?? metadata.height;
    if (!width || !height) throw new Error("image dimensions unavailable");
    const orientation = metadata.orientation;
    return orientation !== undefined && orientation >= 5 && orientation <= 8
        ? { width: height, height: width }
        : { width, height };
}

function fileFormatForSharp(format: MemeFile["format"]): "jpeg" | "png" | "gif" | "webp" {
    return format === "jpg" ? "jpeg" : format;
}

async function readMetadata(input: Buffer, animated: boolean): Promise<Metadata> {
    const image = sharp(input, { animated });
    try { return await image.metadata(); }
    finally { image.destroy(); }
}

async function removeFileWithRetry(path: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
        try {
            await rm(path, { force: true });
            return;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if ((code !== "EBUSY" && code !== "EPERM") || attempt >= 4) throw error;
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 25 * (attempt + 1)));
        }
    }
}

export class MemeSendImageService {
    private cleanupPromise?: Promise<void>;

    constructor(private readonly cacheDirectory = resolve(process.cwd(), "data", "cache", "meme-send")) {}

    async cleanupStaleFiles(): Promise<void> {
        await this.ensureCleanCache();
    }

    async prepare(file: MemeFile, maxEdge: number | null): Promise<PreparedMemeImage> {
        const animatedInput = file.format === "gif" || file.format === "webp";
        const input = await readFile(file.path);
        const metadata = await readMetadata(input, animatedInput);
        const original = frameDimensions(metadata);
        const target = computeMemeSendDimensions(original.width, original.height, maxEdge);
        if (maxEdge === null || (target.width === original.width && target.height === original.height)) {
            return { localPath: file.path, original, target, resized: false, cleanup: async () => undefined };
        }

        await this.ensureCleanCache();
        const temporaryPath = join(this.cacheDirectory, `${randomUUID()}.${file.format}`);
        try {
            const pages = metadata.pages ?? 1;
            const isAnimated = pages > 1;
            if (isAnimated && file.format !== "gif" && file.format !== "webp") {
                throw new Error("unsupported animated image format");
            }
            let pipeline = sharp(input, { animated: animatedInput })
                .rotate()
                .resize({ width: target.width, height: target.height, fit: "inside", withoutEnlargement: true });

            switch (file.format) {
                case "jpg": pipeline = pipeline.jpeg({ quality: 95 }); break;
                case "png": pipeline = pipeline.png({ compressionLevel: 6 }); break;
                case "gif": pipeline = pipeline.gif({
                    ...(isAnimated ? { delay: metadata.delay, loop: metadata.loop ?? 0, keepDuplicateFrames: true } : {}),
                    interFrameMaxError: 0,
                    interPaletteMaxError: 0,
                }); break;
                case "webp": pipeline = pipeline.webp({
                    quality: 100,
                    alphaQuality: 100,
                    lossless: true,
                    exact: true,
                    ...(isAnimated ? { delay: metadata.delay, loop: metadata.loop ?? 0 } : {}),
                }); break;
            }
            let output: Buffer;
            try { output = await pipeline.toBuffer(); }
            finally { pipeline.destroy(); }
            const outputMetadata = await readMetadata(output, animatedInput);
            if (outputMetadata.format !== fileFormatForSharp(file.format)) {
                throw new Error("unexpected output format");
            }
            const actualTarget = frameDimensions(outputMetadata);
            if (actualTarget.width > original.width || actualTarget.height > original.height ||
                (maxEdge !== null && Math.max(actualTarget.width, actualTarget.height) > maxEdge)) {
                throw new Error("resized image exceeds the configured bounds");
            }
            if (metadata.hasAlpha && !outputMetadata.hasAlpha) throw new Error("resized image lost transparency");
            if (isAnimated) {
                if ((outputMetadata.pages ?? 1) !== pages) throw new Error("animation frame count changed during resize");
            }
            await writeFile(temporaryPath, output, { flag: "wx" });
            return {
                localPath: temporaryPath,
                original,
                target: actualTarget,
                resized: true,
                cleanup: async () => { await removeFileWithRetry(temporaryPath).catch(() => undefined); },
            };
        } catch (error) {
            await removeFileWithRetry(temporaryPath).catch(() => undefined);
            throw error;
        }
    }

    private async ensureCleanCache(): Promise<void> {
        this.cleanupPromise ??= (async () => {
            await mkdir(this.cacheDirectory, { recursive: true });
            const entries = await readdir(this.cacheDirectory, { withFileTypes: true });
            await Promise.all(entries.filter((entry) => entry.isFile()).map((entry) =>
                removeFileWithRetry(join(this.cacheDirectory, entry.name))));
        })();
        try { await this.cleanupPromise; }
        catch (error) {
            this.cleanupPromise = undefined;
            throw error;
        }
    }
}

export const memeSendImageService = new MemeSendImageService();
