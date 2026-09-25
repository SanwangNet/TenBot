import "dotenv/config";

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { getPromptStore, type PromptProvider } from "./ai/prompt-store.js";
import { createConfigStore } from "./config/config-store.js";
import { toPublicConfig } from "./config/config-validation.js";
import { createTenBotControl, type ReloadResult, type TenBotControl } from "./control/tenbot-control.js";
import { createProviderErrorNotice } from "./control/provider-error.js";
import type { AutomatedPeerSummary } from "./control/automated-peers.js";
import type { RuntimeStatus } from "./control/runtime-status.js";
import { LogBuffer } from "./control/log-buffer.js";
import { SqliteMemberRepository } from "./members/sqlite-repository.js";
import { MemoryMemberRepository } from "./members/memory-repository.js";
import { createQqBot, type QqConnectionState } from "./qq/bot.js";
import { configureMemberRepository } from "./qq/conversation/known-members.js";
import { automatedPeerLoopGuard } from "./qq/conversation/automated-peer.js";
import { RecentPeerRegistry } from "./qq/conversation/recent-peers.js";
import { getRecentContextConversationCount } from "./qq/conversation/recent-context.js";
import { getActiveReplyCycleCount, shutdownReplyCoordinator, subscribeProviderErrors, subscribeReplyLifecycle } from "./qq/reply/coordinator.js";
import { getMemeRuntimeSnapshot, loadMemeRuntime, reloadMemes as reloadMemeData } from "./skills/meme/skill.js";
import { sampleRecentMemeNames } from "./skills/meme/store.js";
import { memeStore } from "./skills/meme/store.js";
import { logger, setConsoleLogOutputEnabled, setLogLevel, shortId, truncateLogText } from "./shared/logger.js";
import type { NormalizedQqMessage } from "./qq/message/normalize-message.js";
import { FileChangeWatcher } from "./shared/file-change-watcher.js";
import { RuntimeConfigSnapshotStore, type RuntimeConfigSnapshot } from "./runtime-config-snapshot.js";
import { toConversationIdentity } from "./control/conversation-identity.js";

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
        await loadMemeRuntime();
    } catch (error) {
        logs.dispose();
        setConsoleLogOutputEnabled(true);
        throw error;
    }
    const qqConnectionAtStart = runtimeSnapshot.appConfig.qq;

    let qqState: QqConnectionState = "disconnected";
    let shuttingDown = false;
    let startPromise: Promise<void> | undefined;
    let shutdownPromise: Promise<void> | undefined;
    let memberRepository: SqliteMemberRepository | undefined;
    const fileWatchers: FileChangeWatcher[] = [];
    let envWatcher: FileChangeWatcher | undefined;
    let memeWatcher: FileChangeWatcher | undefined;
    const promptWatchers = new Map<PromptProvider, FileChangeWatcher>();
    let lastReloadFailure: { message: string; timestamp: string } | undefined;
    let qqRestartRequired = false;
    let configReloadQueue: Promise<void> = Promise.resolve();

    let control: ReturnType<typeof createTenBotControl> | undefined;
    let unsubscribeProviderErrors: () => void = () => undefined;
    let unsubscribeReplyLifecycle: () => void = () => undefined;
    let conversationItemSequence = 0;
    const observeGroupMessage = (message: NormalizedQqMessage) => {
        if (message.kind !== "group") return;
        const key = message.groupId ? `group:${message.groupId}` : `group:unknown`;
        const { conversationId, label } = toConversationIdentity(key);
        const parsed = message.timestamp ? Date.parse(message.timestamp) : Number.NaN;
        control?.publishEvent({
            type: "conversation-item",
            conversationId,
            label,
            item: {
                id: `message-${++conversationItemSequence}`,
                type: "group-message",
                displayName: truncateLogText(message.authorName || "群友", 60),
                content: truncateLogText(message.displayContent, 2000),
                timestamp: Number.isNaN(parsed) ? new Date().toISOString() : new Date(parsed).toISOString(),
            },
        });
    };
    const observeReplyLifecycle = (signal: Parameters<Parameters<typeof subscribeReplyLifecycle>[0]>[0]) => {
        const { conversationId, label } = toConversationIdentity(signal.conversationKey);
        if (signal.kind === "reply-sent") {
            control?.publishEvent({
                type: "conversation-item", conversationId, label,
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
            type: "conversation-item", conversationId, label,
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
    let bot: ReturnType<typeof createQqBot>;
    try {
        bot = createQqBot((state) => {
            qqState = state;
            control?.publishStatus();
        }, (message) => {
            if (recentPeers.observe(message)) control?.publishEvent({ type: "recent-peers-updated" });
        }, observeGroupMessage, runtimeSnapshot.appConfig.qq);
    } catch (error) {
        logs.dispose();
        setConsoleLogOutputEnabled(true);
        throw error;
    }

    try {
        memberRepository = new SqliteMemberRepository();
        configureMemberRepository(memberRepository);
    } catch (error) {
        memberRepository = undefined;
        configureMemberRepository(new MemoryMemberRepository());
        logger.error("[Members] SQLite unavailable; using memory for this run", error);
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
        async shutdown(): Promise<void> {
            if (shutdownPromise) return shutdownPromise;
            shutdownPromise = (async () => {
                shuttingDown = true;
                control?.publishStatus();
                const stopCycles = shutdownReplyCoordinator();
                try { bot.stop(); }
                catch (error) { logger.error("[QQ] stop error", error); }
                try {
                    await Promise.all([stopCycles, startPromise?.catch(() => undefined)]);
                } finally {
                    try { memberRepository?.close(); }
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
            qqState = "connecting";
            control?.publishStatus();
            startPromise = bot.start().then(() => {
                qqState = "disconnected";
                control?.publishStatus();
            }).catch((error: unknown) => {
                qqState = "error";
                control?.publishStatus();
                logger.error("[QQ] startup failed", error);
                throw error;
            });
            return startPromise;
        },
    };
}
