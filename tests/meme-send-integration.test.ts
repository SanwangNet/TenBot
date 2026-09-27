import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { test } from "node:test";
import type { QQBot } from "@tencent-connect/qqbot-nodejs";

import type { ModelPlugin } from "../src/ai/model-plugin.js";
import { createConfigStore } from "../src/config/config-store.js";
import { MemeLibraryService } from "../src/skills/meme/library-service.js";
import { MemeSendImageService, type MemeSendImagePreparer } from "../src/skills/meme/send-image.js";
import { recordIncomingMessageRevision, rememberIncomingMessage } from "../src/qq/conversation/recent-context.js";
import type { NormalizedQqMessage } from "../src/qq/message/normalize-message.js";
import { coordinateAiReply } from "../src/qq/reply/coordinator.js";
import { RuntimeConfigSnapshotStore } from "../src/runtime-config-snapshot.js";

function fakePlugin(id: "gpt" | "deepseek"): ModelPlugin {
    return {
        id,
        model: "meme-send-test",
        capabilities: { webSearch: false },
        async generate() { throw new Error("the model is stubbed in this test"); },
    };
}

function message(groupId = randomUUID()): NormalizedQqMessage {
    const value = {
        source: {} as never,
        id: randomUUID(),
        kind: "group",
        eventType: "GROUP_MESSAGE_CREATE",
        content: "send meme",
        displayContent: "send meme",
        groupId,
        author: null,
        authorId: "user",
        authorName: "user",
        authorIsBot: false,
        mentions: [],
        attachments: [],
        replyTarget: { scope: "group", targetId: groupId, msgId: randomUUID() },
        raw: {},
    } as NormalizedQqMessage;
    recordIncomingMessageRevision(value);
    rememberIncomingMessage(value, value.displayContent);
    return value;
}

interface ImageCall {
    path: string;
    width?: number;
    height?: number;
    format?: string;
}

function imageBot(options: { failImage?: boolean } = {}) {
    const calls: Array<{ method: string; content?: string; path?: string }> = [];
    const images: ImageCall[] = [];
    const bot = {
        async sendText(_target: unknown, content: string) { calls.push({ method: "text", content }); },
        async sendMarkdown(_target: unknown, content: string) { calls.push({ method: "markdown", content }); },
        async sendImage(_target: unknown, payload: { localPath: string }) {
            calls.push({ method: "image", path: payload.localPath });
            if (options.failImage) throw new Error("simulated QQ upload failure");
            const image = sharp(await readFile(payload.localPath));
            let metadata;
            try { metadata = await image.metadata(); }
            finally { image.destroy(); }
            images.push({ path: payload.localPath, width: metadata.width, height: metadata.height, format: metadata.format });
            return { message: {} };
        },
        async send(_payload: unknown) { calls.push({ method: "send" }); },
    } as unknown as QQBot;
    return { bot, calls, images };
}

async function sendMeme(
    bot: QQBot,
    library: MemeLibraryService,
    filename: string,
    options: {
        getMemeSendMaxEdge: () => number | null;
        memeSendImagePreparer?: MemeSendImagePreparer;
        withText?: boolean;
        onModelCall?: () => void;
    },
): Promise<void> {
    await coordinateAiReply({
        bot,
        message: message(),
        aiInput: "test",
        imageUrls: [],
        isGroup: true,
        wakeLevel: "hard",
        wakeReason: "hard-mention",
        triggerPriority: 3,
        isAtBot: true,
        onWebSearchStart: async () => undefined,
    }, {
        memeLibrary: library,
        multiMessageDelayMs: 0,
        getMemeSendMaxEdge: options.getMemeSendMaxEdge,
        memeSendImagePreparer: options.memeSendImagePreparer,
        executeAi: async () => {
            options.onModelCall?.();
            return {
                kind: "reply",
                action: {
                    messages: options.withText ? [{ content: "text stays sent", quote: { mode: "none", ref: null } }] : [],
                    mentions: [],
                    meme: filename,
                },
            };
        },
    });
}

test("runtime config hot reload changes the very next meme send from 160 px to 128 px", async () => {
    const root = await mkdtemp(join(tmpdir(), "tenbot-meme-send-runtime-"));
    const envPath = join(root, ".env");
    const imageDirectory = join(root, "memes");
    const cacheDirectory = join(root, "cache");
    try {
        const configStore = createConfigStore({ envPath, environment: {} });
        const runtimeSnapshots = new RuntimeConfigSnapshotStore(
            configStore.getAppConfig(),
            (config) => fakePlugin(config.ai.provider),
            () => undefined,
        );
        const getMemeSendMaxEdge = () => runtimeSnapshots.get().appConfig.memeSendMaxEdge;
        const library = new MemeLibraryService(imageDirectory);
        const source = await sharp({
            create: { width: 240, height: 240, channels: 4, background: { r: 30, g: 80, b: 220, alpha: 0.6 } },
        }).png().toBuffer();
        const file = await library.add("large", source);
        const preparer = new MemeSendImageService(cacheDirectory);

        const first = imageBot();
        await sendMeme(first.bot, library, file.filename, { getMemeSendMaxEdge, memeSendImagePreparer: preparer });
        assert.deepEqual([first.images[0]?.width, first.images[0]?.height], [160, 160]);
        assert.notEqual(first.images[0]?.path, file.path);
        await assert.rejects(access(first.images[0]!.path));

        const saved = await configStore.updatePublicConfig({ field: "memeSendMaxEdge", value: 128 });
        assert.equal(saved.ok, true);
        runtimeSnapshots.replace(configStore.getAppConfig());
        assert.equal(getMemeSendMaxEdge(), 128);
        assert.match(await readFile(envPath, "utf8"), /MEME_SEND_MAX_EDGE=128/);

        const second = imageBot();
        await sendMeme(second.bot, library, file.filename, { getMemeSendMaxEdge, memeSendImagePreparer: preparer });
        assert.deepEqual([second.images[0]?.width, second.images[0]?.height], [128, 128]);
        assert.notEqual(second.images[0]?.path, file.path);
        await assert.rejects(access(second.images[0]!.path));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("resize failure falls back to the original image without retrying the model or losing text", async () => {
    const root = await mkdtemp(join(tmpdir(), "tenbot-meme-send-fallback-"));
    try {
        const library = new MemeLibraryService(join(root, "memes"));
        const source = await sharp({
            create: { width: 240, height: 160, channels: 4, background: { r: 200, g: 60, b: 40, alpha: 1 } },
        }).png().toBuffer();
        const file = await library.add("fallback", source);
        const failResize: MemeSendImagePreparer = {
            async prepare() { throw new Error("resize failure includes a private path that should stay out of logs"); },
        };
        const { bot, calls, images } = imageBot({ failImage: true });
        let modelCalls = 0;

        await sendMeme(bot, library, file.filename, {
            getMemeSendMaxEdge: () => 160,
            memeSendImagePreparer: failResize,
            withText: true,
            onModelCall: () => { modelCalls++; },
        });

        assert.equal(modelCalls, 1);
        assert.deepEqual(calls.map((call) => call.method), ["markdown", "image"]);
        assert.equal(calls[0]?.content, "text stays sent");
        assert.equal(calls[1]?.path, file.path);
        assert.deepEqual(images, []);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("original-size setting sends the library file directly", async () => {
    const root = await mkdtemp(join(tmpdir(), "tenbot-meme-send-original-integration-"));
    try {
        const library = new MemeLibraryService(join(root, "memes"));
        const source = await sharp({
            create: { width: 240, height: 160, channels: 4, background: { r: 200, g: 60, b: 40, alpha: 1 } },
        }).png().toBuffer();
        const file = await library.add("original", source);
        const { bot, images } = imageBot();
        await sendMeme(bot, library, file.filename, { getMemeSendMaxEdge: () => null });
        assert.equal(images[0]?.path, file.path);
        assert.deepEqual([images[0]?.width, images[0]?.height], [240, 160]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
