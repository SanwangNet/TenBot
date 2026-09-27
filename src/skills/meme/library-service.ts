import { randomUUID } from "node:crypto";
import { link, mkdir, open, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";

export const MAX_MEME_FILE_BYTES = 16 * 1024 * 1024;

export type MemeImageFormat = "jpg" | "png" | "gif" | "webp";

const MIME_TYPES: Record<MemeImageFormat, string> = {
    jpg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
};

export type MemeLibraryErrorCode = "invalid-name" | "duplicate" | "unsupported-image" | "too-large" | "not-found" | "io";

export class MemeLibraryError extends Error {
    constructor(readonly code: MemeLibraryErrorCode, message: string) {
        super(message);
        this.name = "MemeLibraryError";
    }
}

export interface NormalizedMemeImage {
    bytes: Buffer;
    format: MemeImageFormat;
    contentType: string;
}

export interface MemeFile {
    filename: string;
    path: string;
    format: MemeImageFormat;
    contentType: string;
}

export function detectMemeImageFormat(input: Uint8Array): MemeImageFormat | undefined {
    const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
    if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png";
    if (bytes.length >= 6 && (bytes.toString("ascii", 0, 6) === "GIF87a" || bytes.toString("ascii", 0, 6) === "GIF89a")) return "gif";
    if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "webp";
    return undefined;
}

export function validateMemeName(input: string): string {
    const name = input.trim();
    if (!name || name.length > 80 || name.includes("..") || /[\\/<>:"|?*\x00-\x1f\x7f]/.test(name) || /[. ]$/.test(name)) {
        throw new MemeLibraryError("invalid-name", "表情包名称无效");
    }
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
        throw new MemeLibraryError("invalid-name", "表情包名称无效");
    }
    return name;
}

export function buildAvailableMemeContext(filenames: readonly string[]): string {
    return [
        "<available_meme_files>",
        "可用表情包文件：",
        JSON.stringify(filenames, null, 2),
        "以上表情包是可选资源，可以不用。一轮最多选择一个；只能使用列表中的完整文件名（必须包含扩展名），不要虚构不存在的文件。",
        "</available_meme_files>",
    ].join("\n");
}

export class MemeLibraryService {
    private readonly nameLocks = new Map<string, Promise<void>>();

    constructor(readonly directory = resolve(process.cwd(), "data", "memes")) {}

    normalize(name: string, input: Uint8Array): { name: string; image: NormalizedMemeImage; filename: string } {
        const normalizedName = validateMemeName(name);
        if (input.byteLength > MAX_MEME_FILE_BYTES) {
            throw new MemeLibraryError("too-large", "图片文件超过大小限制");
        }
        const format = detectMemeImageFormat(input);
        if (!format) throw new MemeLibraryError("unsupported-image", "不支持的图片格式");
        const image = { bytes: Buffer.from(input), format, contentType: MIME_TYPES[format] };
        return { name: normalizedName, image, filename: `${normalizedName}.${format}` };
    }

    async list(): Promise<string[]> {
        await mkdir(this.directory, { recursive: true });
        const entries = await readdir(this.directory, { withFileTypes: true });
        const files: string[] = [];
        for (const entry of entries) {
            if (!entry.isFile()) continue;
            const format = extname(entry.name).slice(1).toLowerCase() as MemeImageFormat;
            if (!Object.hasOwn(MIME_TYPES, format)) continue;
            try {
                const path = join(this.directory, entry.name);
                if ((await stat(path)).size > MAX_MEME_FILE_BYTES) continue;
                const handle = await open(path, "r");
                try {
                    const prefix = Buffer.alloc(12);
                    const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
                    if (detectMemeImageFormat(prefix.subarray(0, bytesRead)) === format) files.push(entry.name);
                } finally { await handle.close(); }
            } catch { /* Ignore files that cannot be read as a managed image. */ }
        }
        return files.sort((a, b) => a.localeCompare(b, "zh-CN"));
    }

    async exists(filename: string): Promise<boolean> {
        try { await this.get(filename); return true; }
        catch (error) {
            if (error instanceof MemeLibraryError && error.code === "not-found") return false;
            throw error;
        }
    }

    async get(filename: string): Promise<MemeFile> {
        const safeFilename = validateMemeFilename(filename);
        const files = await this.list();
        if (!files.includes(safeFilename)) throw new MemeLibraryError("not-found", "表情包不存在");
        const format = extname(safeFilename).slice(1).toLowerCase() as MemeImageFormat;
        return { filename: safeFilename, path: join(this.directory, safeFilename), format, contentType: MIME_TYPES[format] };
    }

    async add(name: string, input: Uint8Array): Promise<MemeFile> {
        const normalizedName = validateMemeName(name);
        const lockKey = `${this.directory.toLowerCase()}\0${normalizedName.toLocaleLowerCase("en-US")}`;
        const previous = this.nameLocks.get(lockKey);
        let release!: () => void;
        const current = new Promise<void>((resolveLock) => { release = resolveLock; });
        this.nameLocks.set(lockKey, current);
        await previous;
        try {
            const existing = await this.list();
            if (existing.some((filename) => basename(filename, extname(filename)).toLocaleLowerCase("en-US") === normalizedName.toLocaleLowerCase("en-US"))) {
                throw new MemeLibraryError("duplicate", "琛ㄦ儏鍖呭凡瀛樺湪");
            }
            return await this.addUnlocked(normalizedName, input);
        } finally {
            release();
            if (this.nameLocks.get(lockKey) === current) this.nameLocks.delete(lockKey);
        }
    }

    private async addUnlocked(name: string, input: Uint8Array): Promise<MemeFile> {
        const normalized = this.normalize(name, input);
        await mkdir(this.directory, { recursive: true });
        const destination = join(this.directory, normalized.filename);
        const temporary = join(this.directory, `.meme-${randomUUID()}.tmp`);
        try {
            await writeFile(temporary, normalized.image.bytes, { flag: "wx" });
            try { await link(temporary, destination); }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code === "EEXIST") {
                    throw new MemeLibraryError("duplicate", "表情包已存在");
                }
                throw error;
            }
        } catch (error) {
            if (error instanceof MemeLibraryError) throw error;
            throw new MemeLibraryError("io", "无法保存表情包");
        } finally {
            await rm(temporary, { force: true }).catch(() => undefined);
        }
        return {
            filename: normalized.filename,
            path: destination,
            format: normalized.image.format,
            contentType: normalized.image.contentType,
        };
    }

    async delete(filename: string): Promise<boolean> {
        const file = await this.get(filename);
        try { await unlink(file.path); return true; }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
            throw new MemeLibraryError("io", "无法删除表情包");
        }
    }
}

function validateMemeFilename(input: string): string {
    if (!input || input.length > 90 || basename(input) !== input || /[\\/\x00-\x1f\x7f]/.test(input)) {
        throw new MemeLibraryError("not-found", "表情包不存在");
    }
    const extension = extname(input).slice(1).toLowerCase();
    if (!Object.hasOwn(MIME_TYPES, extension)) throw new MemeLibraryError("not-found", "表情包不存在");
    validateMemeName(input.slice(0, -(extension.length + 1)));
    return input;
}

export const memeLibrary = new MemeLibraryService();
