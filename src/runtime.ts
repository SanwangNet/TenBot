import "dotenv/config";

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { getPromptStore, type PromptProvider } from "./ai/prompt-store.js";
import { createConfigStore } from "./config/config-store.js";
import { toPublicConfig } from "./config/config-validation.js";
import { createTenBotControl, type ReloadResult, type TenBotControl } from "./control/tenbot-control.js";
import { createProviderErrorNotice } from "./control/provider-error.js";
import { summarizeKnownMembers } from "./control/known-members.js";
import type { AutomatedPeerSummary } from "./control/automated-peers.js";
import type { RuntimeStatus } from "./control/runtime-status.js";
import { LogBuffer } from "./control/log-buffer.js";
import { SqliteMemberRepository } from "./members/sqlite-repository.js";
import { MemoryMemberRepository } from "./members/memory-repository.js";
import type { MemberRepository } from "./members/repository.js";
import { createQqBot, shutdownQqMessageHandler, type QqConnectionState } from "./qq/bot.js";
import { configureMemberRepository } from "./qq/conversation/known-members.js";
import { automatedPeerLoopGuard } from "./qq/conversation/automated-peer.js";
import { RecentPeerRegistry } from "./qq/conversation/recent-peers.js";
import { getRecentContextConversationCount } from "./qq/conversation/recent-context.js";
import { cancelGroupReplyCycles, getActiveReplyCycleCount, shutdownReplyCoordinator, subscribeProviderErrors, subscribeReplyLifecycle } from "./qq/reply/coordinator.js";
import { getMemeRuntimeSnapshot, loadMemeRuntime, reloadMemes as reloadMemeData } from "./skills/meme/skill.js";
import { sampleRecentMemeNames } from "./skills/meme/store.js";
import { memeStore } from "./skills/meme/store.js";
import { logger, setConsoleLogOutputEnabled, setLogLevel, shortId, truncateLogText } from "./shared/logger.js";
import type { NormalizedQqMessage } from "./qq/message/normalize-message.js";
import { FileChangeWatcher } from "./shared/file-change-watcher.js";
import { RuntimeConfigSnapshotStore, type RuntimeConfigSnapshot } from "./runtime-config-snapshot.js";
import { toConversationIdentity } from "./control/conversation-identity.js";
import { createIncomingConversationEvent } from "./control/conversation-timeline.js";
import { createTenBotWebServer } from "./control/web-server.js";
import { createEditorResourceStore } from "./control/editor-resources.js";
import { ReplyJudgePromptStore } from "./front/reply-judge-prompt-store.js";
import { OpenAICompatibleReplyJudge } from "./front/openai-compatible-reply-judge.js";
import { GroupReplyControl } from "./runtime/group-reply-control.js";

export interface TenBotRuntime {
    control: TenBotControl;
    start(): Promise<void>;
}

export interface CreateTenBotRuntimeOptions {
    consoleLogs?: boolean;
}

function absolutePath(path: URL | string): string {
    return resolve(path instanceof URL ? fileURLToPath(path) : path);
}

export async function createTenBotRuntime(options: CreateTenBotRuntimeOptions = {}): Promise<TenBotRuntime> {
    setConsoleLogOutputEnabled(options.consoleLogs ?? true);
    const logs = new LogBuffer();
    const configStore = createConfigStore();
    const recentPeers = new RecentPeerRegistry();
    const promptStore = getPromptStore();
    const replyJudgePromptStore = new ReplyJudgePromptStore();
    let runtimeSnapshot!: RuntimeConfigSnapshot;
    let runtimeSnapshots!: RuntimeConfigSnapshotStore;
    try {
        const appConfig = configStore.getAppConfig();
        runtimeSnapshots = new RuntimeConfigSnapshotStore(appConfig);
        runtimeSnapshot = runtimeSnapshots.get();
        const model = runtimeSnapshot.model;
        if (model.id !== "gpt" && model.id !== "deepseek") throw new Error(`Unsupported model id: ${model.id}`);
        automatedPeerLoopGuard.replacePeers(appConfig.botLoopGuard.automatedPeerIds);
        automatedPeerLoopGuard.setMaxCycles(appConfig.botLoopGuard.maxCycles);
        setLogLevel(appConfig.logging.level);
        await promptStore.load(model.id);
        await replyJudgePromptStore.load();
        await loadMemeRuntime();
    } catch (error) {
        logs.dispose();
        setConsoleLogOutputEnabled(true);
        throw error;
    }
    const qqConnectionAtStart = runtimeSnapshot.appConfig.qq;
    const replyJudge = new OpenAICompatibleReplyJudge(() => ({
        ...runtimeSnapshots.get().appConfig.replyJudge,
        prompt: replyJudgePromptStore.get(),
    }));

    let qqState: QqConnectionState = "disconnected";
    let shuttingDown = false;
    let startPromise: Promise<void> | undefined;
    let shutdownPromise: Promise<void> | undefined;
    let memberRepository: MemberRepository = new MemoryMemberRepository();
    let sqliteMemberRepository: SqliteMemberRepository | undefined;
    const fileWatchers: FileChangeWatcher[] = [];
    let envWatcher: FileChangeWatcher | undefined;
    let memeWatcher: FileChangeWatcher | undefined;
    let replyJudgePromptWatcher: FileChangeWatcher | undefined;
    const promptWatchers = new Map<PromptProvider, FileChangeWatcher>();
    let lastReloadFailure: { message: string; timestamp: string } | undefined;
    let qqRestartRequired = false;
    let configReloadQueue: Promise<void> = Promise.resolve();

    let control: ReturnType<typeof createTenBotControl> | undefined;
    let webServer: ReturnType<typeof createTenBotWebServer> | undefined;
    let groupReplyControl: GroupReplyControl | undefined;
    let unsubscribeProviderErrors: () => void = () => undefined;
    let unsubscribeReplyLifecycle: () => void = () => undefined;
    let conversationItemSequence = 0;
    const observeConversationMessage = (message: NormalizedQqMessage) => {
        if (message.kind !== "group" && message.kind !== "c2c" && message.kind !== "dm") return;
        control?.publishEvent(createIncomingConversationEvent(message, `message-${++conversationItemSequence}`));
    };
    const observeReplyLifecycle = (signal: Parameters<Parameters<typeof subscribeReplyLifecycle>[0]>[0]) => {
        const { conversationId, kind, label } = toConversationIdentity(signal.conversationKey);
        if (signal.kind === "reply-sent") {
            control?.publishEvent({
                type: "conversation-item", conversationId, kind, label,
                item: {
                    id: `reply-${++conversationItemSequence}`,
                    type: "ai-reply",
                    content: truncateLogText(signal.content ?? "", 2000),
                    timestamp: signal.timestamp,
                    sendStatus: "sent",
                },
            });
            return;
        }
        const status = signal.kind === "started" ? "generating" : signal.kind;
        control?.publishEvent({
            type: "conversation-item", conversationId, kind, label,
            item: {
                id: `attempt:${signal.attemptId}`,
                type: "ai-attempt",
                cycleId: signal.cycleId,
                attemptId: signal.attemptId,
                timestamp: signal.timestamp,
                status,
                ...(signal.failureStage ? { failureStage: signal.failureStage } : {}),
            },
        });
    };

    const publishReloadFailure = (target: "config" | "prompt" | "memes") => {
        const timestamp = new Date().toISOString();
        const message = "热重载失败，已继续使用旧版本。";
        lastReloadFailure = { message, timestamp };
        control?.publishEvent({ type: "reload-failure", target, message, timestamp });
        control?.publishStatus();
    };

    const reloadRuntimeConfig = async (): Promise<{ ok: boolean; message: string; requiresRestart: boolean }> => {
        let result = { ok: false, message: "热重载失败，已继续使用旧配置。", requiresRestart: qqRestartRequired };
        const operation = configReloadQueue.then(async () => {
            try {
                const nextConfig = configStore.getAppConfig();
                promptStore.get(nextConfig.ai.provider);
                const nextSnapshot = runtimeSnapshots.replace(nextConfig);
                const nextModel = nextSnapshot.model;
                qqRestartRequired = nextConfig.qq.appId !== qqConnectionAtStart.appId ||
                    nextConfig.qq.appSecret !== qqConnectionAtStart.appSecret;
                runtimeSnapshot = nextSnapshot;
                setLogLevel(nextConfig.logging.level);
                automatedPeerLoopGuard.replacePeers(nextConfig.botLoopGuard.automatedPeerIds);
                automatedPeerLoopGuard.setMaxCycles(nextConfig.botLoopGuard.maxCycles);
                lastReloadFailure = undefined;
                result = { ok: true, message: "配置已热重载。", requiresRestart: qqRestartRequired };
                logger.info(`[Runtime] config hot reload revision=${nextSnapshot.revision} provider=${nextModel.id}`);
                control?.publishStatus();
            } catch {
                publishReloadFailure("config");
            }
        });
        configReloadQueue = operation.then(() => undefined, () => undefined);
        await operation;
        return result;
    };
    let stateRepository: { getGroupRepliesEnabled(): Promise<boolean>; setGroupRepliesEnabled(enabled: boolean): Promise<void> } = {
        async getGroupRepliesEnabled() { throw new Error("SQLite state repository is unavailable"); },
        async setGroupRepliesEnabled() { throw new Error("SQLite state repository is unavailable"); },
    };
    try {
        sqliteMemberRepository = new SqliteMemberRepository();
        memberRepository = sqliteMemberRepository;
        stateRepository = sqliteMemberRepository;
        configureMemberRepository(memberRepository);
    } catch (error) {
        memberRepository = new MemoryMemberRepository();
        configureMemberRepository(memberRepository);
        logger.error("[Members] SQLite unavailable; using memory for this run", error);
    }
    groupReplyControl = new GroupReplyControl(stateRepository, (enabled) => {
        if (!enabled) cancelGroupReplyCycles();
        control?.publishStatus();
    });
    await groupReplyControl.initialize();

    let bot: ReturnType<typeof createQqBot>;
    try {
        bot = createQqBot((state) => {
            qqState = state;
            control?.publishStatus();
        }, (message) => {
            if (recentPeers.observe(message)) control?.publishEvent({ type: "recent-peers-updated" });
        }, observeConversationMessage, runtimeSnapshot.appConfig.qq, replyJudge,
        () => runtimeSnapshots.get().appConfig.frontMode,
        () => runtimeSnapshots.get().appConfig.replyJudge.fallbackToMainOnInvalidOutput,
        () => runtimeSnapshots.get().appConfig.replyJudge.turnWaitMs,
        groupReplyControl,
        () => runtimeSnapshots.get().appConfig.botAdminIds);
    } catch (error) {
        logs.dispose();
        setConsoleLogOutputEnabled(true);
        throw error;
    }

    const status = (): RuntimeStatus => {
        const activeModel = runtimeSnapshot.model;
        const activeConfig = runtimeSnapshot.appConfig;
        const provider = activeModel.id as PromptProvider;
        const prompt = promptStore.get(provider);
        const memes = getMemeRuntimeSnapshot();
        const configured = provider === "gpt"
            ? Boolean(activeConfig.ai.gpt.apiKey && activeConfig.ai.gpt.baseURL)
            : Boolean(activeConfig.ai.deepseek.apiKey);
        return {
            qq: qqState,
            groupRepliesEnabled: groupReplyControl?.getGroupRepliesEnabled() ?? false,
            provider: {
                id: provider,
                model: activeModel.model,
                webSearch: activeModel.capabilities.webSearch,
                configured,
                reasoningEffort: activeModel.reasoningEffort,
                verbosity: activeModel.verbosity,
            },
            activeCycles: getActiveReplyCycleCount(),
            contextConversations: getRecentContextConversationCount(),
            runtimeConfig: {
                logLevel: activeConfig.logging.level,
                botLoopGuardMaxCycles: activeConfig.botLoopGuard.maxCycles,
            },
            hotReload: {
                enabled: true,
                revision: runtimeSnapshot.revision,
                loadedAt: runtimeSnapshot.loadedAt,
                lastSuccessAt: runtimeSnapshot.lastSuccessAt,
                ...(lastReloadFailure ? { lastFailure: lastReloadFailure } : {}),
                requiresRestart: qqRestartRequired,
            },
            memes: {
                count: memes.entries.length,
                revision: memes.revision,
                loadedAt: memes.loadedAt,
                path: absolutePath(memeStore.getPath()),
                sampleNames: sampleRecentMemeNames(memes.entries),
            },
            prompt: {
                provider,
                revision: prompt.revision,
                loadedAt: prompt.loadedAt,
                path: absolutePath(promptStore.getPath(provider)),
                characters: prompt.content.length,
                lines: prompt.content.split(/\r?\n/).length,
            },
            shuttingDown,
        };
    };

    const toPeerSummary = (id: string): AutomatedPeerSummary => {
        const recent = recentPeers.get(id);
        return {
            id,
            displayId: shortId(id),
            displayName: recent?.displayName || "未知账号",
            platformBotHint: recent?.platformBotHint ?? false,
            ...(recent ? { lastSeenAt: recent.lastSeenAt } : {}),
        };
    };

    const editorResources = createEditorResourceStore({
        "prompt:gpt": { path: promptStore.getPath("gpt"), displayName: "GPT Prompt", language: "markdown", reload: () => control!.reloadPrompt("gpt") },
        "prompt:deepseek": { path: promptStore.getPath("deepseek"), displayName: "DeepSeek Prompt", language: "markdown", reload: () => control!.reloadPrompt("deepseek") },
        "prompt:reply-judge": { path: replyJudgePromptStore.getPath(), displayName: "Reply Judge Prompt", language: "markdown", reload: () => control!.reloadReplyJudgePrompt() },
        "meme:data": { path: memeStore.getPath(), displayName: "Meme Data", language: "json", reload: () => control!.reloadMemes() },
    });

    control = createTenBotControl({
        getStatus: status,
        getConfig: () => {
            try { return configStore.getPublicConfig(); }
            catch { return toPublicConfig(runtimeSnapshot.appConfig); }
        },
        async updateConfig(patch) {
            const saved = await configStore.updatePublicConfig(patch);
            if (!saved.ok) return saved;
            const applied = await reloadRuntimeConfig();
            await envWatcher?.markCurrent();
            return {
                ...saved,
                requiresRestart: applied.requiresRestart,
                message: applied.ok ? "配置已保存并立即生效。" : applied.message,
            };
        },
        getAutomatedPeers: () => configStore.getAutomatedPeerIds().map(toPeerSummary),
        getRecentPeers: () => {
            const registered = new Set(configStore.getAutomatedPeerIds());
            return recentPeers.list().filter((peer) => !registered.has(peer.id)).map((peer) => toPeerSummary(peer.id));
        },
        async getKnownMembers() {
            try { return summarizeKnownMembers(await memberRepository.listAll()); }
            catch (error) {
                logger.error("[Members] summary read failed", error);
                return [];
            }
        },
        async addAutomatedPeer(id) {
            const result = await configStore.addAutomatedPeer(id);
            if (result.ok) {
                await reloadRuntimeConfig();
                await envWatcher?.markCurrent();
                control?.publishStatus();
            }
            return { ok: result.ok, changed: result.changed, message: result.message, ...("details" in result && result.details ? { details: result.details } : {}) };
        },
        async removeAutomatedPeer(id) {
            const result = await configStore.removeAutomatedPeer(id);
            if (result.ok) {
                await reloadRuntimeConfig();
                await envWatcher?.markCurrent();
                control?.publishStatus();
            }
            return { ok: result.ok, changed: result.changed, message: result.message, ...("details" in result && result.details ? { details: result.details } : {}) };
        },
        subscribeLogs: (listener) => logs.subscribe(listener),
        getEditorResource: (id) => editorResources.get(id),
        saveEditorResource: (id, content, expectedVersion) => editorResources.save(id, content, expectedVersion),
        async reloadPrompt(requestedProvider): Promise<ReloadResult> {
            const target = requestedProvider ?? runtimeSnapshot.model.id as PromptProvider;
            try {
                const prompt = await promptStore.reload(target);
                await promptWatchers.get(target)?.markCurrent();
                lastReloadFailure = undefined;
                logger.info(`[Control] prompt reloaded provider=${target} revision=${prompt.revision}`);
                control?.publishStatus();
                return { ok: true, message: "Prompt reloaded", loadedAt: prompt.loadedAt, revision: prompt.revision };
            } catch (error) {
                logger.error(`[Control] prompt reload failed provider=${target}`, error);
                publishReloadFailure("prompt");
                return { ok: false, message: "Prompt reload failed; keeping the previous version" };
            }
        },
        async reloadMemes(): Promise<ReloadResult> {
            try {
                const memes = await reloadMemeData();
                await memeWatcher?.markCurrent();
                lastReloadFailure = undefined;
                logger.info(`[Control] memes reloaded count=${memes.entries.length} revision=${memes.revision}`);
                control?.publishStatus();
                return { ok: true, message: "Memes reloaded", loadedAt: memes.loadedAt, revision: memes.revision, count: memes.entries.length };
            } catch (error) {
                logger.error("[Control] Meme reload failed; keeping the previous version", error);
                publishReloadFailure("memes");
                return { ok: false, message: "Meme reload failed; keeping the previous version" };
            }
        },
        async reloadReplyJudgePrompt(): Promise<ReloadResult> {
            try {
                const prompt = await replyJudgePromptStore.reload();
                await replyJudgePromptWatcher?.markCurrent();
                lastReloadFailure = undefined;
                logger.info(`[Control] Reply Judge prompt reloaded revision=${prompt.revision}`);
                control?.publishStatus();
                return { ok: true, message: "Reply Judge Prompt reloaded", loadedAt: prompt.loadedAt, revision: prompt.revision };
            } catch {
                publishReloadFailure("prompt");
                return { ok: false, message: "Reply Judge Prompt reload failed; keeping the previous version" };
            }
        },
        async shutdown(): Promise<void> {
            if (shutdownPromise) return shutdownPromise;
            shutdownPromise = (async () => {
                shuttingDown = true;
                control?.publishStatus();
                try { await webServer?.close(); }
                catch (error) { logger.error("[Web] stop failed", error); }
                shutdownQqMessageHandler(bot);
                const stopCycles = shutdownReplyCoordinator();
                try { bot.stop(); }
                catch (error) { logger.error("[QQ] stop error", error); }
                try {
                    await Promise.all([stopCycles, startPromise?.catch(() => undefined)]);
                } finally {
                    try { sqliteMemberRepository?.close(); }
                    catch (error) { logger.error("[Members] SQLite close failed", error); }
                    qqState = "disconnected";
                    control?.publishStatus();
                    clearInterval(statusTimer);
                    unsubscribeProviderErrors();
                    unsubscribeReplyLifecycle();
                    fileWatchers.forEach((watcher) => watcher.close());
                    logs.dispose();
                    setConsoleLogOutputEnabled(true);
                }
            })();
            return shutdownPromise;
        },
    });

    webServer = createTenBotWebServer(control, {
        host: runtimeSnapshot.appConfig.web.host,
        port: runtimeSnapshot.appConfig.web.port,
    });

    envWatcher = new FileChangeWatcher(configStore.getEnvPath(), async () => {
        await reloadRuntimeConfig();
    });
    fileWatchers.push(envWatcher);
    for (const providerId of ["gpt", "deepseek"] as const) {
        const watcher = new FileChangeWatcher(promptStore.getPath(providerId), async () => {
            try {
                const prompt = await promptStore.reload(providerId);
                lastReloadFailure = undefined;
                logger.info(`[Runtime] prompt hot reload provider=${providerId} revision=${prompt.revision}`);
                control?.publishStatus();
            } catch {
                publishReloadFailure("prompt");
            }
        });
        promptWatchers.set(providerId, watcher);
        fileWatchers.push(watcher);
    }
    replyJudgePromptWatcher = new FileChangeWatcher(replyJudgePromptStore.getPath(), async () => {
        try {
            const prompt = await replyJudgePromptStore.reload();
            lastReloadFailure = undefined;
            logger.info("[Runtime] Reply Judge Prompt hot reload revision=" + prompt.revision);
            control?.publishStatus();
        } catch (error) {
            lastReloadFailure = { message: error instanceof Error ? error.message : "Prompt reload failed", timestamp: new Date().toISOString() };
            logger.error("[Runtime] Reply Judge Prompt hot reload failed", error);
            control?.publishStatus();
        }
    });
    fileWatchers.push(replyJudgePromptWatcher);
    memeWatcher = new FileChangeWatcher(memeStore.getPath(), async () => {
        try {
            const snapshot = await reloadMemeData();
            lastReloadFailure = undefined;
            logger.info(`[Runtime] meme hot reload count=${snapshot.entries.length} revision=${snapshot.revision}`);
            control?.publishStatus();
        } catch {
            publishReloadFailure("memes");
        }
    });
    fileWatchers.push(memeWatcher);
    await Promise.all(fileWatchers.map((watcher) => watcher.start()));

    unsubscribeProviderErrors = subscribeProviderErrors((signal) => {
        control?.publishEvent({
            type: "provider-error",
            notice: createProviderErrorNotice(signal.provider, signal.model, signal.error),
        });
    });
    unsubscribeReplyLifecycle = subscribeReplyLifecycle(observeReplyLifecycle);

    let lastStatus = JSON.stringify(status());
    const statusTimer = setInterval(() => {
        const next = JSON.stringify(status());
        if (next !== lastStatus) {
            lastStatus = next;
            control?.publishStatus();
        }
    }, 1000);
    statusTimer.unref();

    return {
        control,
        start(): Promise<void> {
            if (startPromise) return startPromise;
            if (shuttingDown) return Promise.resolve();
            startPromise = (async () => {
                await webServer?.start();
                if (shuttingDown) return;
                qqState = "connecting";
                control?.publishStatus();
                try {
                    await bot.start();
                    qqState = "disconnected";
                    control?.publishStatus();
                } catch (error) {
                    qqState = "error";
                    control?.publishStatus();
                    logger.error("[QQ] startup failed", error);
                    throw error;
                }
            })();
            return startPromise;
        },
    };
}
