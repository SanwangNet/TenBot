export type MemeResizeTarget = 240 | 300 | 384 | 512 | null;
export type MemeImageFormat = "jpg" | "png" | "gif" | "webp";

const MAX_UPLOAD_BYTES = 16 * 1024 * 1024;

export function detectMemeImageFormat(bytes: Uint8Array): MemeImageFormat | undefined {
    const text = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
    if (bytes.length >= 8 && bytes[0] === 137 && text(1, 4) === "PNG" && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10) return "png";
    if (bytes.length >= 6 && (text(0, 6) === "GIF87a" || text(0, 6) === "GIF89a")) return "gif";
    if (bytes.length >= 12 && text(0, 4) === "RIFF" && text(8, 12) === "WEBP") return "webp";
    return undefined;
}

export function computeResizeDimensions(width: number, height: number, maxEdge: number): { width: number; height: number } {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 || maxEdge < 1) {
        throw new Error("图片尺寸无效");
    }
    const scale = Math.min(1, maxEdge / Math.max(width, height));
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function hasApngAnimation(bytes: Uint8Array): boolean {
    let offset = 8;
    while (offset + 12 <= bytes.length) {
        const size = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
        if (size > bytes.length - offset - 12) return true;
        const kind = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
        if (kind === "acTL") return true;
        offset += size + 12;
        if (kind === "IEND") return false;
    }
    return true;
}

function shouldPreserveWebp(bytes: Uint8Array): boolean {
    let offset = 12;
    let sawExtendedHeader = false;
    let sawImageData = false;
    let animatedFlag = false;
    while (offset + 8 <= bytes.length) {
        const kind = String.fromCharCode(...bytes.subarray(offset, offset + 4));
        const size = new DataView(bytes.buffer, bytes.byteOffset + offset + 4, 4).getUint32(0, true);
        const payload = offset + 8;
        if (size > bytes.length - payload) return true;
        if (kind === "ANIM" || kind === "ANMF") return true;
        if (kind === "VP8X") {
            sawExtendedHeader = true;
            if (size < 1) return true;
            animatedFlag = (bytes[payload] & 0x02) !== 0;
        }
        if (kind === "VP8 " || kind === "VP8L") sawImageData = true;
        offset = payload + size + (size & 1);
    }
    if (animatedFlag) return true;
    if (sawExtendedHeader) return !sawImageData;
    if (sawImageData) return false;
    return true;
}

export function shouldPreserveOriginalForAnimation(bytes: Uint8Array, format = detectMemeImageFormat(bytes)): boolean {
    if (format === "gif") return true;
    if (format === "png") return hasApngAnimation(bytes);
    if (format === "webp") return shouldPreserveWebp(bytes);
    return false;
}

export interface PreparedMemeImage {
    bytes: Uint8Array;
    resized: boolean;
    preservedOriginal: boolean;
}

export async function prepareMemeImage(file: Blob, maxEdge: MemeResizeTarget): Promise<PreparedMemeImage> {
    if (file.size > MAX_UPLOAD_BYTES) throw new Error("图片不能超过 16 MB");
    const original = new Uint8Array(await file.arrayBuffer());
    const format = detectMemeImageFormat(original);
    if (!format) throw new Error("仅支持 JPEG、PNG、GIF 和 WebP 图片");
    if (maxEdge === null || shouldPreserveOriginalForAnimation(original, format)) {
        return { bytes: original, resized: false, preservedOriginal: maxEdge !== null };
    }

    const bitmap = await createImageBitmap(file);
    try {
        const size = computeResizeDimensions(bitmap.width, bitmap.height, maxEdge);
        if (size.width === bitmap.width && size.height === bitmap.height) {
            return { bytes: original, resized: false, preservedOriginal: false };
        }
        const mime = format === "jpg" ? "image/jpeg" : `image/${format}`;
        const canvas = document.createElement("canvas");
        canvas.width = size.width;
        canvas.height = size.height;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("无法处理图片尺寸");
        context.drawImage(bitmap, 0, 0, size.width, size.height);
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, format === "jpg" ? 0.92 : undefined));
        if (!blob || blob.type !== mime) throw new Error("图片缩放失败，未上传原图");
        return { bytes: new Uint8Array(await blob.arrayBuffer()), resized: true, preservedOriginal: false };
    } finally {
        bitmap.close();
    }
}
