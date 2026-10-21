import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { QQBot } from "@tencent-connect/qqbot-nodejs";
import { test } from "node:test";
import sharp from "sharp";
import type { ImagesResponse } from "openai/resources/images.js";
import { readFileSync } from "node:fs";

import { ImageGenerationError, ImageGenerationService } from "../src/ai/image-generation-service.js";
import { getImageModelCapabilities, imageSizeSupportedByCapabilities, validateGptImage2CustomSize } from "../src/ai/image-capabilities.js";
import { loadAppConfig } from "../src/config/config-validation.js";
import type { AppConfig } from "../src/config/config-types.js";
import { MemoryMemberRepository } from "../src/members/memory-repository.js";
import { SqliteMemberRepository } from "../src/members/sqlite-repository.js";
import { D1MemberRepository, type D1MemberDatabase } from "../src/members/d1-repository.js";
import { routeCommand } from "../src/commands/router.js";
import { normalizeQqMessage, type NormalizedQqMessage } from "../src/qq/message/normalize-message.js";
import { sendAiImage } from "../src/qq/reply/sender.js";

const TEST_TIME = Date.UTC(2026, 9, 21, 1);

function appConfig(size = "auto", enabled = true): AppConfig {
    return loadAppConfig({
        BOT_TIME_ZONE: "Asia/Shanghai",
        CODEX_API_KEY: "mock-key",
        CODEX_BASE_URL: "https://example.invalid/v1",
        CODEX_MODEL: "gpt-6-sol",
        IMAGE_GENERATION_ENABLED: String(enabled),
        IMAGE_GENERATION_MODEL: "gpt-image-2.5-flare",
        IMAGE_GENERATION_QUALITY: "low",
        IMAGE_GENERATION_SIZE: size,
        IMAGE_GENERATION_OUTPUT_FORMAT: "png",
    });
}

async function pngBase64(width = 1024, height = 1024): Promise<string> {
    const bytes = await sharp({
        create: { width, height, channels: 3, background: { r: 20, g: 30, b: 40 } },
    }).png().toBuffer();
    return bytes.toString("base64");
}

function apiResponse(base64: string, usage = true): ImagesResponse {
    return {
        created: Math.floor(TEST_TIME / 1_000),
        data: [{ b64_json: base64 }],
        ...(usage ? { usage: { input_tokens: 14, output_tokens: 515, total_tokens: 529,
            input_tokens_details: { text_tokens: 14, image_tokens: 0 },
            output_tokens_details: { text_tokens: 0, image_tokens: 515 } } } : {}),
    } as unknown as ImagesResponse;
}

function imageInput(messageId = "message-1", memberOpenid = "member-1") {
    return { prompt: "一只在月球上吃泡面的猫", groupOpenid: "group-1", memberOpenid, messageId };
}

function makeMessage(content: string): NormalizedQqMessage {
    return {
        source: {} as NormalizedQqMessage["source"],
        id: "trigger-message-1",
        kind: "group",
        eventType: "GROUP_MESSAGE_CREATE",
        content,
        displayContent: content,
        groupId: "group-1",
        author: { member_openid: "member-1" },
        authorId: "member-1",
        authorName: "测试用户",
        authorIsBot: false,
        mentions: [],
        attachments: [],
        replyTarget: { scope: "group", targetId: "group-1", msgId: "trigger-message-1" },
        raw: {},
    };
}

function errorCode(error: unknown): string | undefined {
    return error instanceof ImageGenerationError ? error.code : undefined;
}

test("/绘图 command runs the image service once and quotes the original QQ message", async () => {
    const root = await mkdtemp(join(tmpdir(), "tenbot-image-command-"));
    const repository = new MemoryMemberRepository(() => TEST_TIME);
    const calls: Array<Record<string, unknown>> = [];
    const sends: Array<Record<string, unknown>> = [];
    const uploaded: Array<Record<string, unknown>> = [];
    const response = apiResponse(await pngBase64());
    const service = new ImageGenerationService({
        getConfig: () => appConfig(), repository, imageDirectory: root, now: () => TEST_TIME,
        createClient: () => ({ images: { async generate(body, options) {
            calls.push({ ...body, maxRetries: options?.maxRetries });
            return response;
        } } }),
    });
    const bot = {
        async sendText() { return undefined; },
        async uploadMedia(input: Record<string, unknown>) { uploaded.push(input); return { file_info: "uploaded-media" }; },
        async send(payload: Record<string, unknown>) { sends.push(payload); return { id: "sent-1" }; },
    } as unknown as QQBot;
    try {
        assert.equal(await routeCommand(bot, makeMessage("/绘图 一只猫"), {
            isOwner: () => false,
            memeCandidates: undefined,
            memeLibrary: undefined,
            imageGenerationService: service,
        } as never), true);
        assert.equal(calls.length, 1);
        assert.equal(calls[0]?.prompt, "一只猫");
        assert.equal(calls[0]?.size, "auto");
        assert.equal(calls[0]?.maxRetries, 0);
        assert.equal(uploaded.length, 1);
        assert.deepEqual((sends[0]?.messageReference as { message_id: string }).message_id, "trigger-message-1");
        const rows = await repository.listImageGenerationUsage();
        assert.equal(rows[0]?.status, "succeeded");
        assert.equal(rows[0]?.sendStatus, "quoted");
    } finally {
        await service.shutdown();
        await rm(root, { recursive: true, force: true });
    }
});

test("QQ delivery with an unknown result is not retried and retains the generated artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "tenbot-image-send-unknown-"));
    const repository = new MemoryMemberRepository(() => TEST_TIME);
    let generationCalls = 0;
    let sendCalls = 0;
    const notices: string[] = [];
    const service = new ImageGenerationService({
        getConfig: () => appConfig(), repository, imageDirectory: root, now: () => TEST_TIME,
        createClient: () => ({ images: { async generate() { generationCalls++; return apiResponse(await pngBase64()); } } }),
    });
    const bot = {
        async sendText(_target: unknown, content: string) { notices.push(content); },
        async uploadMedia() { return { file_info: "uploaded" }; },
        async send() { sendCalls++; throw Object.assign(new Error("response lost"), { status: 500 }); },
    } as unknown as QQBot;
    try {
        await routeCommand(bot, makeMessage("/绘图 一只猫"), {
            isOwner: () => false, memeCandidates: undefined, memeLibrary: undefined, imageGenerationService: service,
        } as never);
        const [row] = await repository.listImageGenerationUsage();
        assert.equal(generationCalls, 1);
        assert.equal(sendCalls, 1, "an uncertain QQ result must not cause an unquoted resend");
        assert.equal(row?.sendStatus, "unknown");
        assert.equal(row?.status, "send_failed");
        await access(row!.imagePath!);
        const metadata = JSON.parse(await readFile(join(root, row!.requestId!, "request.json"), "utf8")) as Record<string, unknown>;
        assert.equal(metadata.sendStatus, "unknown");
        assert.ok(notices.some((notice) => notice.includes("尚无法确认")));
    } finally {
        await service.shutdown();
        await rm(root, { recursive: true, force: true });
    }
});

test("natural language image intent stays ordinary text and does not enter the command router", async () => {
    const bot = { async sendText() { throw new Error("must not send"); } } as unknown as QQBot;
    const result = await routeCommand(bot, makeMessage("帮我画一只猫"));
    assert.equal(result, false);
});

test("empty /绘图 prompt prints usage without calling the generator", async () => {
    const sent: string[] = [];
    const bot = { async sendText(_target: unknown, content: string) { sent.push(content); } } as unknown as QQBot;
    const generate = async () => { throw new Error("must not generate"); };
    await routeCommand(bot, makeMessage("/绘图"), {
        isOwner: () => false, memeCandidates: undefined, memeLibrary: undefined,
        imageGenerationService: { isEnabled: () => true, generate } as never,
    } as never);
    assert.equal(sent.length, 1);
    assert.match(sent[0]!, /用法：\/绘图/);
});

test("disabled drawing refuses before upstream generation", async () => {
    const root = await mkdtemp(join(tmpdir(), "tenbot-image-disabled-"));
    let calls = 0;
    const service = new ImageGenerationService({
        getConfig: () => appConfig("auto", false), repository: new MemoryMemberRepository(), imageDirectory: root,
        createClient: () => ({ images: { async generate() { calls++; return apiResponse(await pngBase64()); } } }),
    });
    try {
        await assert.rejects(service.generate(imageInput()), (error) => errorCode(error) === "M:C_IG_DSB");
        assert.equal(calls, 0);
    } finally {
        await service.shutdown();
        await rm(root, { recursive: true, force: true });
    }
});

test("Auto is passed unchanged and persists a private permanent image artifact and usage", async () => {
    const root = await mkdtemp(join(tmpdir(), "tenbot-image-artifact-"));
    const repository = new MemoryMemberRepository(() => TEST_TIME);
    const body: Record<string, unknown>[] = [];
    const base64 = await pngBase64(1536, 1024);
    const service = new ImageGenerationService({
        getConfig: () => appConfig("auto"), repository, imageDirectory: root, now: () => TEST_TIME,
        createClient: () => ({ images: { async generate(params) { body.push({ ...params }); return apiResponse(base64); } } }),
    });
    try {
        const generated = await service.generate(imageInput());
        assert.equal(body[0]?.size, "auto");
        assert.equal(generated.requestedSize, "auto");
        assert.equal(generated.actualSize, "1536x1024");
        const imageBytesBefore = await readFile(generated.localPath);
        const meta = JSON.parse(await readFile(join(root, generated.requestId, "request.json"), "utf8")) as Record<string, unknown>;
        assert.equal(meta.requestId, generated.requestId);
        assert.equal(meta.requestedSize, "auto");
        assert.equal(meta.actualSize, "1536x1024");
        assert.equal(meta.generationStatus, "succeeded");
        assert.equal(meta.sendStatus, "pending");
        assert.equal((meta.usage as { totalTokens: number }).totalTokens, 529);
        assert.equal("apiKey" in meta, false);
        assert.equal("b64_json" in meta, false);
        await service.finish(generated, "failed");
        assert.deepEqual(await readFile(generated.localPath), imageBytesBefore, "send failure must retain the generated image");
        const finalMetadata = JSON.parse(await readFile(join(root, generated.requestId, "request.json"), "utf8")) as Record<string, unknown>;
        assert.equal(finalMetadata.sendStatus, "failed");
        const row = (await repository.listImageGenerationUsage())[0]!;
        assert.equal(row.sendStatus, "failed");
        assert.equal(row.imagePath, generated.localPath);
        assert.equal(row.actualSize, "1536x1024");
    } finally {
        await service.shutdown();
        await rm(root, { recursive: true, force: true });
    }
});

test("unique requests use isolated UUID folders and cleanup never removes successful files", async () => {
    const root = await mkdtemp(join(tmpdir(), "tenbot-image-isolation-"));
    const service = new ImageGenerationService({
        getConfig: () => appConfig(), repository: new MemoryMemberRepository(() => TEST_TIME), imageDirectory: root,
        now: () => TEST_TIME,
        createClient: () => ({ images: { async generate() { return apiResponse(await pngBase64()); } } }),
    });
    try {
        const first = await service.generate(imageInput("message-a", "member-a"));
        await service.finish(first, "quoted");
        const second = await service.generate(imageInput("message-b", "member-b"));
        await service.finish(second, "quoted");
        assert.notEqual(first.requestId, second.requestId);
        assert.notEqual(first.localPath, second.localPath);
        assert.equal((await readdir(root)).length, 2);
        await access(first.localPath);
        await access(second.localPath);
    } finally {
        await service.shutdown();
        await rm(root, { recursive: true, force: true });
    }
});

test("manual size is transmitted exactly and a mismatched response is retained but never sent", async () => {
    const root = await mkdtemp(join(tmpdir(), "tenbot-image-size-mismatch-"));
    const repository = new MemoryMemberRepository(() => TEST_TIME);
    const sent: string[] = [];
    const service = new ImageGenerationService({
        getConfig: () => appConfig("2048x1152"), repository, imageDirectory: root, now: () => TEST_TIME,
        createClient: () => ({ images: { async generate(body) { sent.push(String(body.size)); return apiResponse(await pngBase64(1536, 1024)); } } }),
    });
    try {
        await assert.rejects(service.generate(imageInput()), (error) => {
            assert.equal(errorCode(error), "M:C_IG_SZM");
            assert.equal((error as ImageGenerationError).details?.requestedSize, "2048x1152");
            assert.equal((error as ImageGenerationError).details?.actualSize, "1536x1024");
            return true;
        });
        assert.deepEqual(sent, ["2048x1152"]);
        const row = (await repository.listImageGenerationUsage())[0]!;
        assert.equal(row.status, "failed");
        assert.equal(row.generationStatus, "size_mismatch");
        assert.equal(row.sendStatus, "not_attempted");
        assert.equal(row.size, "2048x1152");
        assert.equal(row.actualSize, "1536x1024");
        await access(row.imagePath!);
        const metadata = JSON.parse(await readFile(join(root, row.requestId!, "request.json"), "utf8")) as Record<string, unknown>;
        assert.equal(metadata.generationStatus, "size_mismatch");
        assert.equal(metadata.requestedSize, "2048x1152");
        assert.equal((metadata.usage as { totalTokens: number }).totalTokens, 529);
    } finally {
        await service.shutdown();
        await rm(root, { recursive: true, force: true });
    }
});

test("a matching strict manual size reaches the Images API unchanged and is recorded", async () => {
    const root = await mkdtemp(join(tmpdir(), "tenbot-image-exact-size-"));
    const repository = new MemoryMemberRepository(() => TEST_TIME);
    let requestedSize = "";
    const service = new ImageGenerationService({
        getConfig: () => appConfig("2048x1152"), repository, imageDirectory: root, now: () => TEST_TIME,
        createClient: () => ({ images: { async generate(body) { requestedSize = String(body.size); return apiResponse(await pngBase64(2048, 1152)); } } }),
    });
    try {
        const generated = await service.generate(imageInput());
        assert.equal(requestedSize, "2048x1152");
        assert.equal(generated.actualSize, "2048x1152");
        await service.finish(generated, "quoted");
        assert.equal((await repository.listImageGenerationUsage())[0]?.generationStatus, "succeeded");
    } finally {
        await service.shutdown();
        await rm(root, { recursive: true, force: true });
    }
});

test("upstream dimension rejection is specific and is never retried with a replacement size", async () => {
    const root = await mkdtemp(join(tmpdir(), "tenbot-image-size-rejected-"));
    let calls = 0;
    const service = new ImageGenerationService({
        getConfig: () => appConfig("2048x1152"), repository: new MemoryMemberRepository(() => TEST_TIME), imageDirectory: root,
        createClient: () => ({ images: { async generate() {
            calls++;
            throw Object.assign(new Error("size is not supported"), { status: 400 });
        } } }),
    });
    try {
        await assert.rejects(service.generate(imageInput()), (error) => errorCode(error) === "R:C_MP_SIZ");
        assert.equal(calls, 1);
    } finally {
        await service.shutdown();
        await rm(root, { recursive: true, force: true });
    }
});

test("custom dimensions validate only under supported GPT Image 2 profiles", () => {
    const gptImage2 = getImageModelCapabilities("gpt-image-2");
    const unknown = getImageModelCapabilities("private-image-endpoint");
    assert.equal(validateGptImage2CustomSize("1792x1024"), true);
    assert.equal(validateGptImage2CustomSize("1793x1024"), false);
    assert.equal(validateGptImage2CustomSize("4096x1024"), false);
    assert.equal(validateGptImage2CustomSize("1024x1024"), true);
    assert.equal(imageSizeSupportedByCapabilities("1792x1024", gptImage2), true);
    assert.equal(imageSizeSupportedByCapabilities("1792x1024", unknown), false);
    assert.equal(imageSizeSupportedByCapabilities("auto", gptImage2), true);
    assert.equal(imageSizeSupportedByCapabilities("auto", unknown), false);
    assert.equal(imageSizeSupportedByCapabilities("2048x1152", unknown), false);
});

test("quote rejection falls back with the same uploaded media; uncertain result is never resent", async () => {
    const message = makeMessage("/绘图 一只猫");
    let uploads = 0;
    const sent: Array<Record<string, unknown>> = [];
    const bot = {
        async uploadMedia() { uploads++; return { file_info: "same-media" }; },
        async send(payload: Record<string, unknown>) {
            sent.push(payload);
            if (sent.length === 1) throw Object.assign(new Error("quote expired"), { status: 400 });
            return { id: "unquoted-id" };
        },
    } as unknown as QQBot;
    const fallback = await sendAiImage(bot, message, "local-image.png", () => true);
    assert.equal(fallback.status, "unquoted");
    assert.equal(uploads, 1);
    assert.equal((sent[0]?.messageReference as { message_id: string }).message_id, "trigger-message-1");
    assert.equal(sent[1]?.messageReference, undefined);
    assert.deepEqual(sent[0]?.media, sent[1]?.media);

    uploads = 0;
    sent.length = 0;
    const uncertainBot = {
        async uploadMedia() { uploads++; return { file_info: "same-media" }; },
        async send(payload: Record<string, unknown>) { sent.push(payload); throw new Error("socket closed without response"); },
    } as unknown as QQBot;
    const uncertain = await sendAiImage(uncertainBot, message, "local-image.png", () => true);
    assert.equal(uncertain.status, "unknown");
    assert.equal(uploads, 1);
    assert.equal(sent.length, 1);
});

test("same member daily quota persists across SQLite repository restart", async () => {
    const parent = await mkdtemp(join(tmpdir(), "tenbot-image-quota-restart-"));
    const dbPath = join(parent, "bot.db");
    const imageRoot = join(parent, "files");
    let repository: SqliteMemberRepository | undefined = new SqliteMemberRepository(dbPath, () => TEST_TIME);
    const service = new ImageGenerationService({
        getConfig: () => appConfig(), repository, imageDirectory: imageRoot, now: () => TEST_TIME,
        limits: { perMemberPerGroupDaily: 1 },
        createClient: () => ({ images: { async generate() { return apiResponse(await pngBase64()); } } }),
    });
    try {
        const generated = await service.generate(imageInput("daily-first"));
        await service.finish(generated, "quoted");
        await service.shutdown();
        repository.close();
        repository = new SqliteMemberRepository(dbPath, () => TEST_TIME);
        const afterRestart = new ImageGenerationService({
            getConfig: () => appConfig(), repository, imageDirectory: imageRoot, now: () => TEST_TIME,
            limits: { perMemberPerGroupDaily: 1 },
            createClient: () => ({ images: { async generate() { throw new Error("quota must block before API"); } } }),
        });
        try {
            await assert.rejects(afterRestart.generate(imageInput("daily-second")), (error) => errorCode(error) === "M:C_IG_DQL");
            const rows = await repository.listImageGenerationUsage();
            assert.equal(rows.length, 1);
            assert.equal(rows[0]?.status, "succeeded");
            assert.equal(rows[0]?.totalTokens, 529);
        } finally {
            await afterRestart.shutdown();
        }
    } finally {
        await service.shutdown();
        repository?.close();
        await rm(parent, { recursive: true, force: true });
    }
});

test("duplicate messages and global concurrency are rejected before another upstream request", async () => {
    const root = await mkdtemp(join(tmpdir(), "tenbot-image-concurrency-"));
    const repository = new MemoryMemberRepository(() => TEST_TIME);
    let release: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let calls = 0;
    const service = new ImageGenerationService({
        getConfig: () => appConfig(), repository, imageDirectory: root, now: () => TEST_TIME,
        createClient: () => ({ images: { async generate() { calls++; markStarted?.(); await gate; return apiResponse(await pngBase64()); } } }),
    });
    try {
        const first = service.generate(imageInput("same-message", "member-a"));
        await started;
        await assert.rejects(service.generate(imageInput("same-message", "member-a")), (error) => errorCode(error) === "M:C_IG_DUP");
        await assert.rejects(service.generate(imageInput("other-message", "member-b")), (error) => errorCode(error) === "M:C_IG_GBL");
        assert.equal(calls, 1);
        release?.();
        const generated = await first;
        await service.finish(generated, "quoted");
    } finally {
        release?.();
        await service.shutdown();
        await rm(root, { recursive: true, force: true });
    }
});

test("GPT tool schemas do not offer generate_image", async () => {
    // model-plugin.test inspects the actual Responses request body. This guards the local
    // catalog of helper exports too: image generation is only exposed by the slash command.
    const { listCommands } = await import("../src/commands/router.js");
    assert.ok(listCommands().some((command) => command.name === "绘图"));
    assert.equal(listCommands().some((command) => command.name === "generate_image"), false);
});

test("SQLite repository migration keeps the image artifact side table queryable", async () => {
    const root = await mkdtemp(join(tmpdir(), "tenbot-image-migration-"));
    const path = join(root, "members.db");
    const repo = new SqliteMemberRepository(path, () => TEST_TIME);
    const inspect = new DatabaseSync(path);
    try {
        const table = inspect.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='image_generation_artifacts'").get();
        assert.ok(table);
        const row = await repo.listImageGenerationUsage();
        assert.deepEqual(row, []);
    } finally {
        inspect.close();
        repo.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("D1 adapter persists image artifacts, send status, dimensions, and real usage", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(readFileSync(new URL("../migrations/0009_image_generation_requests.sql", import.meta.url), "utf8"));
    db.exec(readFileSync(new URL("../migrations/0010_image_generation_artifacts.sql", import.meta.url), "utf8"));
    const adapter: D1MemberDatabase = {
        prepare(query) {
            return {
                bind(...values) {
                    const statement = db.prepare(query);
                    return {
                        async run() { return statement.run(...values); },
                        async first<T>() { return (statement.get(...values) as T | undefined) ?? null; },
                        async all<T>() { return { results: statement.all(...values) as T[] }; },
                    };
                },
            };
        },
    };
    const repository = new D1MemberRepository(adapter, () => TEST_TIME);
    try {
        const reservation = {
            requestKey: "d1-request", groupOpenid: "group-1", memberOpenid: "member-1", messageId: "d1-message",
            dayKey: "2026-10-21", model: "gpt-image-2.5-flare", size: "auto", quality: "low", outputFormat: "png",
            requestedAt: TEST_TIME, dailyLimit: 3, globalConcurrency: 1,
        };
        assert.deepEqual(await repository.reserveImageGenerationRequest(reservation), { kind: "reserved" });
        assert.equal(await repository.markImageGenerationSubmitted("d1-request", TEST_TIME + 1), true);
        await repository.recordImageGenerationResult("d1-request", "generated",
            { inputTokens: 14, outputTokens: 515, totalTokens: 529, imageTokens: 515, textTokens: 14 }, TEST_TIME + 2, {
                requestId: "b2efad3b-7d4b-45f8-bcf5-18d911ef28a8", prompt: "一只猫", actualSize: "1536x1024",
                actualFormat: "png", imagePath: "data/sandbox/files/img/b2efad3b-7d4b-45f8-bcf5-18d911ef28a8/image.png",
                generationStatus: "succeeded", sendStatus: "pending", updatedAt: TEST_TIME + 2,
            });
        await repository.finishImageGenerationRequest("d1-request", "succeeded", TEST_TIME + 3, "quoted");
        const [row] = await repository.listImageGenerationUsage();
        assert.equal(row?.requestId, "b2efad3b-7d4b-45f8-bcf5-18d911ef28a8");
        assert.equal(row?.actualSize, "1536x1024");
        assert.equal(row?.imagePath?.includes("data/sandbox/files/img"), true);
        assert.equal(row?.status, "succeeded");
        assert.equal(row?.sendStatus, "quoted");
        assert.equal(row?.totalTokens, 529);
        assert.equal(row?.imageTokens, 515);
    } finally {
        db.close();
    }
});

test("normalizing inbound QQ keeps trigger message ID for later image quote", async () => {
    const inbound = {
        kind: "group", rawEventType: "GROUP_MESSAGE_CREATE", messageId: "qq-original-id", content: "/绘图 一只猫",
        groupOpenid: "group-1", senderId: "member-1", replyTarget: { scope: "group", targetId: "group-1", msgId: "qq-original-id" },
        mentions: [], attachments: [], raw: { group_openid: "group-1", mentions: [] },
    } as never;
    const normalized = await normalizeQqMessage({}, inbound);
    assert.equal(normalized.id, "qq-original-id");
    const bot = {
        async uploadMedia() { return { file_info: "image" }; },
        async send(payload: Record<string, unknown>) { return { id: "ok", payload }; },
    } as unknown as QQBot;
    const result = await sendAiImage(bot, normalized, "file.png", () => true);
    assert.equal(result.status, "quoted");
});
