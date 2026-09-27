import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { test } from "node:test";

import type { MemeFile, MemeImageFormat } from "../src/skills/meme/library-service.js";
import { MemeSendImageService, computeMemeSendDimensions } from "../src/skills/meme/send-image.js";

const mimeType: Record<MemeImageFormat, string> = {
    jpg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
};

async function createStaticImage(path: string, width: number, height: number, format: "jpg" | "png" | "webp"): Promise<void> {
    const image = sharp({
        create: { width, height, channels: 4, background: { r: 40, g: 120, b: 210, alpha: 0.4 } },
    });
    try {
        if (format === "jpg") await image.jpeg({ quality: 95 }).toFile(path);
        else if (format === "png") await image.png().toFile(path);
        else await image.webp({ lossless: true }).toFile(path);
    } finally { image.destroy(); }
}

async function readMetadata(path: string, animated = false) {
    const image = sharp(await readFile(path), { animated });
    try { return await image.metadata(); }
    finally { image.destroy(); }
}

function memeFile(path: string, format: MemeImageFormat, filename = `source.${format}`): MemeFile {
    return { path, filename, format, contentType: mimeType[format] };
}

async function makeAnimatedPages(path: string, format: "gif" | "webp"): Promise<void> {
    const width = 240;
    const frameHeight = 240;
    const frameCount = 3;
    const pixels = Buffer.alloc(width * frameHeight * frameCount * 4);
    const colors = [[255, 0, 0], [0, 255, 0], [0, 0, 255]];
    for (let frame = 0; frame < frameCount; frame++) {
        const [red, green, blue] = colors[frame]!;
        const frameStart = frame * width * frameHeight * 4;
        for (let offset = frameStart; offset < frameStart + width * frameHeight * 4; offset += 4) {
            pixels[offset] = red!;
            pixels[offset + 1] = green!;
            pixels[offset + 2] = blue!;
            pixels[offset + 3] = 255;
        }
    }
    const input = sharp(pixels, {
        raw: { width, height: frameHeight * frameCount, channels: 4, pageHeight: frameHeight },
    });
    try {
        if (format === "gif") {
            await input.gif({ delay: [70, 90, 110], loop: 0, keepDuplicateFrames: true }).toFile(path);
        } else {
            await input.webp({ delay: [70, 90, 110], loop: 0, lossless: true }).toFile(path);
        }
    } finally { input.destroy(); }
}

test("meme send dimensions preserve ratios, resize only down, and preserve static formats", async () => {
    const root = await mkdtemp(join(tmpdir(), "tenbot-meme-send-static-"));
    const service = new MemeSendImageService(join(root, "cache"));
    try {
        const cases = [
            { width: 300, height: 300, expected: [160, 160] },
            { width: 400, height: 200, expected: [160, 80] },
            { width: 200, height: 400, expected: [80, 160] },
            { width: 92, height: 92, expected: [92, 92] },
        ] as const;
        for (const [index, item] of cases.entries()) {
            const source = join(root, `source-${index}.png`);
            await createStaticImage(source, item.width, item.height, "png");
            const prepared = await service.prepare(memeFile(source, "png"), 160);
            try {
                const output = await readMetadata(prepared.localPath);
                assert.deepEqual([output.width, output.height], item.expected);
                assert.equal(prepared.resized, index !== 3);
                assert.equal(output.format, "png");
                assert.equal(output.hasAlpha, true);
            } finally {
                await prepared.cleanup();
            }
        }

        assert.deepEqual(computeMemeSendDimensions(719, 611, 160), { width: 160, height: 136 });
        assert.deepEqual(computeMemeSendDimensions(92, 92, 160), { width: 92, height: 92 });

        for (const format of ["jpg", "png", "webp"] as const) {
            const source = join(root, `format-source.${format}`);
            await createStaticImage(source, 300, 150, format);
            const prepared = await service.prepare(memeFile(source, format), 160);
            try {
                const output = await readMetadata(prepared.localPath);
                assert.deepEqual([output.width, output.height], [160, 80]);
                assert.equal(output.format, format === "jpg" ? "jpeg" : format);
                if (format !== "jpg") assert.equal(output.hasAlpha, true);
            } finally {
                await prepared.cleanup();
            }
        }
    } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});

test("original-size mode returns the library file without creating a temporary copy", async () => {
    const root = await mkdtemp(join(tmpdir(), "tenbot-meme-send-original-"));
    const cache = join(root, "cache");
    const source = join(root, "source.png");
    await createStaticImage(source, 300, 200, "png");
    try {
        const prepared = await new MemeSendImageService(cache).prepare(memeFile(source, "png"), null);
        assert.equal(prepared.localPath, source);
        assert.equal(prepared.resized, false);
        await assert.rejects(access(cache));
        await prepared.cleanup();
        await access(source);
    } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});

test("startup cleanup removes leftover temporary send files", async () => {
    const root = await mkdtemp(join(tmpdir(), "tenbot-meme-send-stale-"));
    const cache = join(root, "cache");
    try {
        await mkdir(cache, { recursive: true });
        await writeFile(join(cache, "leftover.png"), "stale");
        await new MemeSendImageService(cache).cleanupStaleFiles();
        assert.deepEqual(await readdir(cache), []);
    } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});

test("resized GIF and animated WebP keep every frame, dimensions, delays, and loop metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "tenbot-meme-send-animation-"));
    const service = new MemeSendImageService(join(root, "cache"));
    try {
        for (const format of ["gif", "webp"] as const) {
            const source = join(root, `animation.${format}`);
            await makeAnimatedPages(source, format);
            const input = await readMetadata(source, true);
            assert.equal(input.pages, 3, `${format} fixture should contain multiple frames`);
            const prepared = await service.prepare(memeFile(source, format, `misleading.jpg`), 160);
            try {
                const output = await readMetadata(prepared.localPath, true);
                assert.equal(output.format, format);
                assert.equal(output.width, 160);
                assert.equal(output.pageHeight, 160);
                assert.equal(output.pages, input.pages);
                assert.equal(output.loop, input.loop);
                assert.deepEqual(output.delay, input.delay);
            } finally {
                await prepared.cleanup();
            }
        }
    } finally {
        const leftovers = await readdir(join(root, "cache")).catch(() => []);
        assert.deepEqual(leftovers, []);
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});
