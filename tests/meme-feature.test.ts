import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { QQBot } from "@tencent-connect/qqbot-nodejs";
import type { NormalizedQqMessage } from "../src/qq/message/normalize-message.js";
import { routeCommand } from "../src/commands/router.js";
import { MemeCandidateTracker } from "../src/skills/meme/candidate-tracker.js";
import { buildAvailableMemeContext, detectMemeImageFormat, MemeLibraryError, MemeLibraryService } from "../src/skills/meme/library-service.js";
import { normalizeQQReplyAction } from "../src/skills/qq-reply/skill.js";
import { computeResizeDimensions, shouldPreserveOriginalForAnimation } from "../web/src/components/meme-image.js";

const gif = Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00", "binary");
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
function message(options: {
    group?: string; user?: string; command?: string; attachment?: Record<string, unknown>;
    id?: string; refIdx?: string; quotedImages?: NormalizedQqMessage["quotedImages"];
    quotedMessage?: NormalizedQqMessage["quotedMessage"];
} = {}): NormalizedQqMessage {
    const content = options.command ?? "image";
    return {
        source: { refMsgIdx: options.refIdx } as never, id: options.id ?? "message-id", kind: "group", eventType: "GROUP_AT_MESSAGE_CREATE",
        content, displayContent: content, groupId: options.group ?? "group-a", author: null,
        authorId: options.user ?? "owner-a", authorName: "member", authorIsBot: false,
        mentions: [], attachments: options.attachment ? [options.attachment] : [],
        replyTarget: { scope: "group", targetId: options.group ?? "group-a", msgId: options.id ?? "message-id" }, raw: {},
        quotedImages: options.quotedImages, quotedMessage: options.quotedMessage,
    } as NormalizedQqMessage;
}
function response(bytes: Uint8Array): Response {
    const body = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(body).set(bytes);
    return new Response(body, { status: 200 });
}

test("meme library sniffs bytes, keeps originals, rejects duplicates and supports list/get/delete", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tenbot-memes-"));
    try {
        const service = new MemeLibraryService(directory);
        const added = await service.add("动态图", gif);
        assert.equal(added.filename, "动态图.gif");
        assert.deepEqual(await service.list(), ["动态图.gif"]);
        assert.equal((await service.get("动态图.gif")).contentType, "image/gif");
        await assert.rejects(service.add("动态图", png), (error: unknown) => error instanceof MemeLibraryError && error.code === "duplicate");
        await assert.rejects(service.add("../escape", png), (error: unknown) => error instanceof MemeLibraryError && error.code === "invalid-name");
        assert.equal(await service.delete("动态图.gif"), true);
        assert.deepEqual(await service.list(), []);

        const competing = await Promise.allSettled([service.add("same-name", gif), service.add("same-name", png)]);
        assert.equal(competing.filter((item) => item.status === "fulfilled").length, 1);
        assert.equal(competing.filter((item) => item.status === "rejected" && item.reason instanceof MemeLibraryError && item.reason.code === "duplicate").length, 1);
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test("supported image signatures are detected independently of filenames and content types", () => {
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    const webp = Buffer.from("RIFF\x00\x00\x00\x00WEBP", "binary");
    assert.equal(detectMemeImageFormat(jpg), "jpg");
    assert.equal(detectMemeImageFormat(png), "png");
    assert.equal(detectMemeImageFormat(gif), "gif");
    assert.equal(detectMemeImageFormat(webp), "webp");
    assert.equal(detectMemeImageFormat(Buffer.from("not an image")), undefined);
});

test("candidate capture is owner and group/member isolated, latest wins, expires and consumes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tenbot-candidates-"));
    let now = 1000;
    try {
        const tracker = new MemeCandidateTracker({
            cacheDirectory: directory, ttlMs: 600, now: () => now,
            fetcher: async () => response(gif),
        });
        const image = (group: string, user: string, url: string) => message({ group, user, attachment: {
            content_type: "image/gif", filename: "saved.jpg", url, width: 240, height: 240,
        } });
        const first = await tracker.remember(image("g1", "owner", "https://cdn.example/first"), true);
        assert.equal(first?.format, "gif");
        assert.equal(first?.originalFilename, "saved.jpg");
        assert.equal(await tracker.remember(image("g1", "other", "https://cdn.example/other"), false), undefined);
        assert.equal(await tracker.latest("g1", "other"), undefined);
        assert.equal(await tracker.latest("g2", "owner"), undefined);
        const otherGroup = await tracker.remember(image("g2", "owner", "https://cdn.example/group-two"), true);
        assert.equal((await tracker.latest("g1", "owner"))?.candidateId, first?.candidateId);
        assert.equal((await tracker.latest("g2", "owner"))?.candidateId, otherGroup?.candidateId);
        const latest = await tracker.remember(image("g1", "owner", "https://cdn.example/second"), true);
        assert.equal((await tracker.latest("g1", "owner"))?.candidateId, latest?.candidateId);
        assert.notEqual(latest?.candidateId, first?.candidateId);
        const claim = await tracker.claim("g1", "owner");
        assert.equal(claim.kind, "candidate");
        if (claim.kind !== "candidate") throw new Error("expected candidate");
        assert.deepEqual(await tracker.read(claim.candidate), gif);
        assert.equal(await tracker.consume(claim.candidate), true);
        assert.equal(await tracker.latest("g1", "owner"), undefined);
        await tracker.remember(image("g1", "owner", "https://cdn.example/third"), true);
        now += 601;
        assert.equal(await tracker.latest("g1", "owner"), undefined);
        await tracker.dispose();
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test("candidate generation makes a later fast image win when downloads complete out of order", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tenbot-candidate-race-"));
    let finishFirst!: (value: Response) => void;
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });
    try {
        const tracker = new MemeCandidateTracker({ cacheDirectory: directory, fetcher: async (url) => {
            if (url.endsWith("first")) { firstStarted(); return await new Promise<Response>((resolve) => { finishFirst = resolve; }); }
            return response(png);
        } });
        const make = (url: string) => message({ user: "owner", attachment: { content_type: "image/png", url } });
        const slow = tracker.remember(make("https://cdn.example/first"), true);
        await started;
        const fast = await tracker.remember(make("https://cdn.example/second"), true);
        finishFirst(response(gif));
        assert.equal(await slow, undefined);
        assert.equal((await tracker.latest("group-a", "owner"))?.candidateId, fast?.candidateId);
        assert.equal((await tracker.latest("group-a", "owner"))?.format, "png");
        await tracker.dispose();
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a command can wait for the current owner candidate download to finish", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tenbot-candidate-wait-"));
    let finishDownload!: (value: Response) => void;
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    try {
        const tracker = new MemeCandidateTracker({ cacheDirectory: directory, fetcher: async () => {
            signalStarted();
            return await new Promise<Response>((resolve) => { finishDownload = resolve; });
        } });
        const capture = tracker.remember(message({ attachment: { content_type: "image/gif", url: "https://cdn.example/wait" } }), true);
        await started;
        let latestResolved = false;
        const latest = tracker.latest("group-a", "owner-a").then((candidate) => { latestResolved = true; return candidate; });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(latestResolved, false);
        finishDownload(response(gif));
        const [captured, found] = await Promise.all([capture, latest]);
        assert.equal(found?.candidateId, captured?.candidateId);
        await tracker.dispose();
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test("invalid candidate URLs and failed downloads never create a usable candidate", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tenbot-candidate-error-"));
    try {
        const tracker = new MemeCandidateTracker({ cacheDirectory: directory, fetcher: async () => { throw new Error("offline"); } });
        const invalid = message({ attachment: { content_type: "image/png", url: "http://127.0.0.1/private" } });
        const failed = message({ attachment: { content_type: "image/png", url: "https://cdn.example/fail" } });
        assert.equal(await tracker.remember(invalid, true), undefined);
        assert.equal(await tracker.remember(failed, true), undefined);
        assert.equal(await tracker.latest("group-a", "owner-a"), undefined);
        await tracker.dispose();
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test("/添加表情 has fixed owner outcomes and failed adds retain the candidate", async () => {
    const cache = await mkdtemp(join(tmpdir(), "tenbot-command-cache-"));
    const libraryRoot = await mkdtemp(join(tmpdir(), "tenbot-command-library-"));
    try {
        const tracker = new MemeCandidateTracker({ cacheDirectory: cache, fetcher: async () => response(gif) });
        const library = new MemeLibraryService(libraryRoot);
        await tracker.remember(message({ attachment: { content_type: "image/gif", filename: "still.jpg", url: "https://cdn.example/gif" } }), true);
        const calls: string[] = [];
        const bot = { async sendText(_target: unknown, text: string) { calls.push(text); } } as unknown as QQBot;
        const services = { isOwner: (id: string | undefined) => id === "owner-a", memeCandidates: tracker, memeLibrary: library };
        const command = (name: string, user = "owner-a") => message({ user, command: `/添加表情 ${name}` });

        await routeCommand(bot, command(".."), services);
        assert.match(calls.at(-1) ?? "", /名称无效/);
        assert.ok(await tracker.latest("group-a", "owner-a"), "failed add must retain candidate");
        await routeCommand(bot, command("动态图"), services);
        assert.equal(calls.at(-1), "已添加表情包");
        assert.ok((await library.list()).includes("动态图.gif"));
        await tracker.remember(message({ attachment: { content_type: "image/gif", filename: "new.jpg", url: "https://cdn.example/new" } }), true);
        await routeCommand(bot, command("动态图"), services);
        assert.equal(calls.at(-1), "表情包已存在");
        assert.ok(await tracker.latest("group-a", "owner-a"), "duplicate add must retain candidate");
        await routeCommand(bot, command("第二个", "other-user"), services);
        assert.equal(calls.at(-1), "无权限");
        await routeCommand(bot, command("第二个"), services);
        assert.equal(calls.at(-1), "已添加表情包");
        await routeCommand(bot, command("第三个"), services);
        assert.equal(calls.at(-1), "未找到你最近发送的表情包");
        await tracker.dispose();
    } finally {
        await rm(cache, { recursive: true, force: true });
        await rm(libraryRoot, { recursive: true, force: true });
    }
});

test("quoted /添加表情 uses the exact local image and allows another member's image", async () => {
    const cache = await mkdtemp(join(tmpdir(), "tenbot-quote-cache-"));
    const libraryRoot = await mkdtemp(join(tmpdir(), "tenbot-quote-library-"));
    const downloads: string[] = [];
    try {
        const tracker = new MemeCandidateTracker({ cacheDirectory: cache, fetcher: async (url) => {
            downloads.push(url);
            return response(url.endsWith("friend") ? png : gif);
        } });
        const library = new MemeLibraryService(libraryRoot);
        const calls: string[] = [];
        const bot = { async sendText(_target: unknown, text: string) { calls.push(text); } } as unknown as QQBot;
        const services = { isOwner: (id: string | undefined) => id === "owner-a", memeCandidates: tracker, memeLibrary: library };
        await tracker.remember(message({ id: "own-image", attachment: {
            content_type: "image/gif", url: "https://cdn.example/own", filename: "own.gif",
        } }), true);

        const ownQuote = message({ command: "/添加表情 自己的图", refIdx: "quote-own", quotedMessage: {
            realMessageId: "own-image",
        }, quotedImages: [{ url: "https://cdn.example/own", contentType: "image/gif" }] });
        await routeCommand(bot, ownQuote, services);
        assert.equal(calls.at(-1), "已添加表情包");
        assert.deepEqual(await readFile((await library.get("自己的图.gif")).path), gif);
        assert.deepEqual(downloads, ["https://cdn.example/own"], "the quote reads its exact local cache without another download");

        const friendQuote = message({ command: "/添加表情 群友图", refIdx: "quote-friend", quotedMessage: {
            realMessageId: "friend-message",
        }, quotedImages: [{ url: "https://cdn.example/friend", contentType: "image/png" }] });
        await routeCommand(bot, friendQuote, services);
        assert.equal(calls.at(-1), "已添加表情包");
        assert.ok((await library.list()).includes("群友图.png"));
        await tracker.dispose();
    } finally {
        await rm(cache, { recursive: true, force: true });
        await rm(libraryRoot, { recursive: true, force: true });
    }
});

test("quoted images take priority; empty quotes never fall back, while no-quote commands consume latest", async () => {
    const cache = await mkdtemp(join(tmpdir(), "tenbot-quote-priority-cache-"));
    const libraryRoot = await mkdtemp(join(tmpdir(), "tenbot-quote-priority-library-"));
    try {
        const tracker = new MemeCandidateTracker({ cacheDirectory: cache, fetcher: async (url) => response(url.endsWith("quoted-B") ? png : gif) });
        const library = new MemeLibraryService(libraryRoot);
        const calls: string[] = [];
        const bot = { async sendText(_target: unknown, text: string) { calls.push(text); } } as unknown as QQBot;
        const services = { isOwner: (id: string | undefined) => id === "owner-a", memeCandidates: tracker, memeLibrary: library };
        await tracker.remember(message({ id: "candidate-A", attachment: {
            content_type: "image/gif", url: "https://cdn.example/candidate-A",
        } }), true);

        await routeCommand(bot, message({ command: "/添加表情 引用B", refIdx: "ref-B", quotedMessage: {
            realMessageId: "quoted-B",
        }, quotedImages: [{ url: "https://cdn.example/quoted-B", contentType: "image/png" }] }), services);
        assert.equal(calls.at(-1), "已添加表情包");
        assert.ok((await library.list()).includes("引用B.png"), "the quoted image wins over candidate A");
        assert.ok(await tracker.latest("group-a", "owner-a"), "quoted success preserves the owner's candidate");

        await routeCommand(bot, message({ command: "/添加表情 普通文字引用", refIdx: "ref-text", quotedImages: [] }), services);
        assert.equal(calls.at(-1), "引用的消息没有可添加的图片");
        await routeCommand(bot, message({ command: "/添加表情 商城表情", refIdx: "ref-shop", quotedImages: [] }), services);
        assert.equal(calls.at(-1), "引用的消息没有可添加的图片");
        assert.ok(await tracker.latest("group-a", "owner-a"), "non-image quotes never consume or use the candidate");

        await routeCommand(bot, message({ command: "/添加表情 无引用" }), services);
        assert.equal(calls.at(-1), "已添加表情包");
        assert.ok((await library.list()).includes("无引用.gif"));
        assert.equal(await tracker.latest("group-a", "owner-a"), undefined, "legacy success consumes latest");
        await tracker.dispose();
    } finally {
        await rm(cache, { recursive: true, force: true });
        await rm(libraryRoot, { recursive: true, force: true });
    }
});

test("quoted download does not wait for an unrelated owner candidate capture", async () => {
    const cache = await mkdtemp(join(tmpdir(), "tenbot-quote-race-cache-"));
    const libraryRoot = await mkdtemp(join(tmpdir(), "tenbot-quote-race-library-"));
    let finishCandidate!: (value: Response) => void;
    let signalCandidateStarted!: () => void;
    const candidateStarted = new Promise<void>((resolve) => { signalCandidateStarted = resolve; });
    try {
        const tracker = new MemeCandidateTracker({ cacheDirectory: cache, fetcher: async (url) => {
            if (url.endsWith("candidate-A")) {
                signalCandidateStarted();
                return await new Promise<Response>((resolve) => { finishCandidate = resolve; });
            }
            return response(png);
        } });
        const library = new MemeLibraryService(libraryRoot);
        const calls: string[] = [];
        const bot = { async sendText(_target: unknown, text: string) { calls.push(text); } } as unknown as QQBot;
        const services = { isOwner: (id: string | undefined) => id === "owner-a", memeCandidates: tracker, memeLibrary: library };
        const candidate = tracker.remember(message({ id: "candidate-A-message", attachment: {
            content_type: "image/gif", url: "https://cdn.example/candidate-A",
        } }), true);
        await candidateStarted;
        const quotedSend = routeCommand(bot, message({ command: "/添加表情 引用B", refIdx: "ref-B", quotedMessage: {
            realMessageId: "quoted-B",
        }, quotedImages: [{ url: "https://cdn.example/quoted-B", contentType: "image/png" }] }), services);
        const completed = await Promise.race([
            quotedSend.then(() => true),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
        ]);
        assert.equal(completed, true, "quote processing must not wait for candidate A's network request");
        assert.equal(calls.at(-1), "已添加表情包");
        finishCandidate(response(gif));
        await candidate;
        assert.ok(await tracker.latest("group-a", "owner-a"));
        await tracker.dispose();
    } finally {
        await rm(cache, { recursive: true, force: true });
        await rm(libraryRoot, { recursive: true, force: true });
    }
});

test("quoted GIF uses detected bytes even when QQ reports a jpg filename and JPEG content type", async () => {
    const cache = await mkdtemp(join(tmpdir(), "tenbot-quote-gif-cache-"));
    const libraryRoot = await mkdtemp(join(tmpdir(), "tenbot-quote-gif-library-"));
    try {
        const tracker = new MemeCandidateTracker({ cacheDirectory: cache, fetcher: async () => response(gif) });
        const library = new MemeLibraryService(libraryRoot);
        const calls: string[] = [];
        const bot = { async sendText(_target: unknown, text: string) { calls.push(text); } } as unknown as QQBot;
        const services = { isOwner: (id: string | undefined) => id === "owner-a", memeCandidates: tracker, memeLibrary: library };
        await routeCommand(bot, message({ command: "/添加表情 动态引用", refIdx: "ref-gif", quotedImages: [{
            url: "https://cdn.example/animated", contentType: "image/jpeg", filename: "xxx.jpg",
        }] }), services);
        assert.equal(calls.at(-1), "已添加表情包");
        const file = await library.get("动态引用.gif");
        assert.deepEqual(await readFile(file.path), gif);
        await tracker.dispose();
    } finally {
        await rm(cache, { recursive: true, force: true });
        await rm(libraryRoot, { recursive: true, force: true });
    }
});

test("quoted download failure reports an explicit error and never falls back", async () => {
    const cache = await mkdtemp(join(tmpdir(), "tenbot-quote-failure-cache-"));
    const libraryRoot = await mkdtemp(join(tmpdir(), "tenbot-quote-failure-library-"));
    try {
        const tracker = new MemeCandidateTracker({ cacheDirectory: cache, fetcher: async (url) => {
            if (url.endsWith("expired")) throw new Error("expired");
            return response(gif);
        } });
        const library = new MemeLibraryService(libraryRoot);
        const calls: string[] = [];
        const bot = { async sendText(_target: unknown, text: string) { calls.push(text); } } as unknown as QQBot;
        const services = { isOwner: (id: string | undefined) => id === "owner-a", memeCandidates: tracker, memeLibrary: library };
        await tracker.remember(message({ id: "candidate-A", attachment: {
            content_type: "image/gif", url: "https://cdn.example/candidate-A",
        } }), true);
        await routeCommand(bot, message({ command: "/添加表情 下载失败", refIdx: "ref-expired", quotedImages: [{
            url: "https://cdn.example/expired", contentType: "image/png",
        }] }), services);
        assert.equal(calls.at(-1), "引用的图片已失效或无法下载");
        assert.deepEqual(await library.list(), []);
        assert.ok(await tracker.latest("group-a", "owner-a"), "failed quote retains latest but does not use it");
        await tracker.dispose();
    } finally {
        await rm(cache, { recursive: true, force: true });
        await rm(libraryRoot, { recursive: true, force: true });
    }
});

test("AI meme protocol accepts three texts plus one meme and meme-only; available names are exact", () => {
    const messages = ["one", "two", "three"].map((content) => ({ content, quote: { mode: "none", ref: null } }));
    assert.equal(normalizeQQReplyAction({ messages, mentions: [], meme: "气笑了.gif" })?.messages.length, 3);
    assert.deepEqual(normalizeQQReplyAction({ messages: [], mentions: [], meme: "猫猫.png" })?.messages, []);
    assert.equal(normalizeQQReplyAction({ messages: [], mentions: [], meme: null }), null);
    const context = buildAvailableMemeContext(["气笑了.jpg", "猫猫震惊.gif"]);
    assert.match(context, /气笑了\.jpg/);
    assert.match(context, /猫猫震惊\.gif/);
});

test("WebUI resize uses longest edge, never enlarges, and conservatively preserves GIF animation", () => {
    assert.deepEqual(computeResizeDimensions(1200, 800, 300), { width: 300, height: 200 });
    assert.deepEqual(computeResizeDimensions(400, 1000, 300), { width: 120, height: 300 });
    assert.deepEqual(computeResizeDimensions(92, 92, 300), { width: 92, height: 92 });
    assert.equal(shouldPreserveOriginalForAnimation(gif), true);
});
