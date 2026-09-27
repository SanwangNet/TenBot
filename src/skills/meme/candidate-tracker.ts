import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { NormalizedQqMessage } from "../../qq/message/normalize-message.js";
import { logger } from "../../shared/logger.js";
import { detectMemeImageFormat, MAX_MEME_FILE_BYTES, type MemeImageFormat } from "./library-service.js";

export const DEFAULT_MEME_CANDIDATE_TTL_MS = 10 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 15_000;
const CLEANUP_INTERVAL_MS = 60_000;

export interface MemeCandidate {
    candidateId: string;
    groupOpenid: string;
    memberOpenid: string;
    messageId?: string;
    receivedAt: number;
    contentType?: string;
    originalFilename?: string;
    width?: number;
    height?: number;
    sourceUrl: string;
    localCachePath: string;
    format: MemeImageFormat;
}

export interface MemeCandidateTrackerOptions {
    cacheDirectory?: string;
    ttlMs?: number;
    now?: () => number;
    fetcher?: (url: string, init: RequestInit) => Promise<Response>;
}

export type MemeCandidateClaim =
    | { kind: "candidate"; candidate: MemeCandidate }
    | { kind: "missing" }
    | { kind: "busy" };

function isPrivateIpv4(host: string): boolean {
    const parts = host.split(".").map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
    return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 ||
        (parts[0] === 169 && parts[1] === 254) ||
        (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
        (parts[0] === 192 && parts[1] === 168) || parts[0] >= 224;
}

function isPrivateIpv6(host: string): boolean {
    const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
    return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") ||
        normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") ||
        normalized.startsWith("fea") || normalized.startsWith("feb");
}

export function isSafeMemeCandidateUrl(value: string): boolean {
    try {
        const url = new URL(value);
        if (url.protocol !== "https:" || url.username || url.password) return false;
        const host = url.hostname.toLowerCase();
        if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return false;
        const ipVersion = isIP(host);
        if (ipVersion === 4) return !isPrivateIpv4(host);
        if (ipVersion === 6) return !isPrivateIpv6(host);
        return host.includes(".");
    } catch { return false; }
}

function candidateKey(groupOpenid: string, memberOpenid: string): string {
    return JSON.stringify([groupOpenid, memberOpenid]);
}

export class MemeCandidateTracker {
    private readonly cacheDirectory: string;
    private readonly ttlMs: number;
    private readonly now: () => number;
    private readonly fetcher: (url: string, init: RequestInit) => Promise<Response>;
    private readonly candidates = new Map<string, MemeCandidate>();
    private readonly pendingCandidates = new Map<string, Promise<void>>();
    private readonly generations = new Map<string, number>();
    private readonly claimed = new Map<string, string>();
    private ready?: Promise<void>;
    private cleanupTimer?: NodeJS.Timeout;

    constructor(options: MemeCandidateTrackerOptions = {}) {
        this.cacheDirectory = resolve(options.cacheDirectory ?? resolve(process.cwd(), "data", "cache", "meme-candidates"));
        this.ttlMs = options.ttlMs ?? DEFAULT_MEME_CANDIDATE_TTL_MS;
        this.now = options.now ?? Date.now;
        this.fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
    }

    async remember(message: NormalizedQqMessage, isOwner: boolean): Promise<MemeCandidate | undefined> {
        if (!isOwner || message.kind !== "group" || !message.groupId || !message.authorId) return undefined;
        const attachment = [...message.attachments].reverse().find((item: any) => {
            const contentType = item?.content_type ?? item?.contentType;
            return typeof contentType === "string" && contentType.startsWith("image/") && typeof item?.url === "string";
        });
        if (!attachment) return undefined;

        await this.ensureReady();
        const key = candidateKey(message.groupId, message.authorId);
        const generation = (this.generations.get(key) ?? 0) + 1;
        this.generations.set(key, generation);
        const previous = this.candidates.get(key);
        this.candidates.delete(key);
        if (previous) await rm(previous.localCachePath, { force: true }).catch(() => undefined);

        const receivedAt = this.now();
        let completePending!: () => void;
        const pending = new Promise<void>((resolvePending) => { completePending = resolvePending; });
        this.pendingCandidates.set(key, pending);
        let pendingCachePath: string | undefined;
        try {
            const image = await this.download(attachment.url);
            const candidateId = randomUUID();
            const localCachePath = join(this.cacheDirectory, `${candidateId}.${image.format}`);
            pendingCachePath = localCachePath;
            await writeFile(localCachePath, image.bytes, { flag: "wx" });
            if (this.generations.get(key) !== generation || this.now() - receivedAt >= this.ttlMs) {
                await rm(localCachePath, { force: true });
                return undefined;
            }
            const candidate: MemeCandidate = {
                candidateId,
                groupOpenid: message.groupId,
                memberOpenid: message.authorId,
                messageId: message.id,
                receivedAt,
                contentType: attachment.content_type ?? attachment.contentType,
                originalFilename: attachment.filename,
                width: attachment.width,
                height: attachment.height,
                sourceUrl: attachment.url,
                localCachePath,
                format: image.format,
            };
            this.candidates.set(key, candidate);
            pendingCachePath = undefined;
            logger.debug(`[MemeCandidate] cached format=${image.format}`);
            return candidate;
        } catch (error) {
            if (pendingCachePath) await rm(pendingCachePath, { force: true }).catch(() => undefined);
            logger.error(`[MemeCandidate] image capture failed (${error instanceof Error ? error.name : "unknown error"})`);
            return undefined;
        } finally {
            completePending();
            if (this.pendingCandidates.get(key) === pending) this.pendingCandidates.delete(key);
        }
    }

    async latest(groupOpenid: string, memberOpenid: string): Promise<MemeCandidate | undefined> {
        await this.ensureReady();
        const key = candidateKey(groupOpenid, memberOpenid);
        let pending = this.pendingCandidates.get(key);
        while (pending) {
            await pending;
            const next = this.pendingCandidates.get(key);
            if (next === pending) break;
            pending = next;
        }
        await this.expire();
        return this.candidates.get(key);
    }

    async claim(groupOpenid: string, memberOpenid: string): Promise<MemeCandidateClaim> {
        const key = candidateKey(groupOpenid, memberOpenid);
        if (this.claimed.has(key)) return { kind: "busy" };
        const candidate = await this.latest(groupOpenid, memberOpenid);
        if (!candidate) return { kind: "missing" };
        if (this.claimed.has(key)) return { kind: "busy" };
        this.claimed.set(key, candidate.candidateId);
        return { kind: "candidate", candidate };
    }

    async consume(candidate: MemeCandidate): Promise<boolean> {
        const key = candidateKey(candidate.groupOpenid, candidate.memberOpenid);
        const current = this.candidates.get(key);
        if (this.claimed.get(key) === candidate.candidateId) this.claimed.delete(key);
        if (current?.candidateId !== candidate.candidateId) return false;
        this.candidates.delete(key);
        await rm(candidate.localCachePath, { force: true }).catch(() => undefined);
        return true;
    }

    release(candidate: MemeCandidate): void {
        const key = candidateKey(candidate.groupOpenid, candidate.memberOpenid);
        if (this.claimed.get(key) === candidate.candidateId) this.claimed.delete(key);
    }

    async expire(now = this.now()): Promise<number> {
        let expired = 0;
        for (const [key, candidate] of this.candidates) {
            if (now - candidate.receivedAt < this.ttlMs) continue;
            this.candidates.delete(key);
            if (this.claimed.get(key) === candidate.candidateId) this.claimed.delete(key);
            await rm(candidate.localCachePath, { force: true }).catch(() => undefined);
            expired++;
        }
        return expired;
    }

    async cleanup(): Promise<void> {
        await this.ensureReady();
        await this.expire();
    }

    async read(candidate: MemeCandidate): Promise<Buffer> {
        await this.expire();
        const key = candidateKey(candidate.groupOpenid, candidate.memberOpenid);
        if (this.candidates.get(key)?.candidateId !== candidate.candidateId) {
            throw new Error("Meme candidate is no longer available");
        }
        return readFile(candidate.localCachePath);
    }

    /** Read a cached capture only when its exact QQ message ID matches the quote. */
    async readForMessage(groupOpenid: string, messageId: string): Promise<Buffer | undefined> {
        await this.ensureReady();
        const candidate = [...this.candidates.values()].find((item) =>
            item.groupOpenid === groupOpenid && item.messageId === messageId);
        if (!candidate || candidate.messageId !== messageId || this.now() - candidate.receivedAt >= this.ttlMs) return undefined;
        try { return await readFile(candidate.localCachePath); }
        catch { return undefined; }
    }

    /** Download a quoted image through the same URL, size and magic-byte checks as captures. */
    async downloadImage(url: string): Promise<Buffer> {
        return (await this.download(url)).bytes;
    }

    async dispose(): Promise<void> {
        if (this.cleanupTimer) clearInterval(this.cleanupTimer);
        this.cleanupTimer = undefined;
    }

    private async ensureReady(): Promise<void> {
        this.ready ??= this.initialize();
        await this.ready;
    }

    private async initialize(): Promise<void> {
        await mkdir(this.cacheDirectory, { recursive: true });
        for (const entry of await readdir(this.cacheDirectory, { withFileTypes: true })) {
            if (entry.isFile()) await rm(join(this.cacheDirectory, entry.name), { force: true }).catch(() => undefined);
        }
        this.cleanupTimer = setInterval(() => { void this.expire().catch(() => undefined); }, CLEANUP_INTERVAL_MS);
        this.cleanupTimer.unref();
    }

    private async download(url: string): Promise<{ bytes: Buffer; format: MemeImageFormat }> {
        if (!isSafeMemeCandidateUrl(url)) throw new Error("Invalid image URL");
        const response = await this.fetcher(url, {
            method: "GET",
            redirect: "error",
            signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        });
        if (!response.ok) throw new Error("Image download failed");
        const contentLength = Number(response.headers.get("content-length"));
        if (Number.isFinite(contentLength) && contentLength > MAX_MEME_FILE_BYTES) throw new Error("Image is too large");
        const bytes = Buffer.from(await response.arrayBuffer());
        if (!bytes.length || bytes.length > MAX_MEME_FILE_BYTES) throw new Error("Image is too large or empty");
        const format = detectMemeImageFormat(bytes);
        if (!format) throw new Error("Downloaded content is not a supported image");
        return { bytes, format };
    }
}

export const memeCandidateTracker = new MemeCandidateTracker();
