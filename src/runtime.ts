import "dotenv/config";

import { getModelPlugin } from "./ai/model-registry.js";
import type { ModelPlugin } from "./ai/model-plugin.js";
import { getPromptStore, type PromptProvider } from "./ai/prompt-store.js";
import { createConfigStore } from "./config/config-store.js";
import { loadAppConfig } from "./config/config-validation.js";
import type { AppConfig } from "./config/config-types.js";
import { createTenBotControl, type ReloadResult, type TenBotControl } from "./control/tenbot-control.js";
import { createProviderErrorNotice } from "./control/provider-error.js";
import type { RuntimeStatus } from "./control/runtime-status.js";
import { LogBuffer } from "./control/log-buffer.js";
import { SqliteMemberRepository } from "./members/sqlite-repository.js";
import { MemoryMemberRepository } from "./members/memory-repository.js";
import { createQqBot, type QqConnectionState } from "./qq/bot.js";
import { configureMemberRepository } from "./qq/conversation/known-members.js";
import { getRecentContextConversationCount } from "./qq/conversation/recent-context.js";
import { getActiveReplyCycleCount, shutdownReplyCoordinator, subscribeProviderErrors } from "./qq/reply/coordinator.js";
import { getMemeRuntimeSnapshot, loadMemeRuntime, reloadMemes as reloadMemeData } from "./skills/meme/skill.js";
import { logger, setConsoleLogOutputEnabled } from "./shared/logger.js";

export interface TenBotRuntime {
    control: TenBotControl;
    start(): Promise<void>;
}

export interface CreateTenBotRuntimeOptions {
    consoleLogs?: boolean;
}

export async function createTenBotRuntime(options: CreateTenBotRuntimeOptions = {}): Promise<TenBotRuntime> {
    setConsoleLogOutputEnabled(options.consoleLogs ?? true);
    const logs = new LogBuffer();
    const configStore = createConfigStore();
    let appConfig: AppConfig;
    const promptStore = getPromptStore();
    let model: ModelPlugin;
    let provider: PromptProvider;
    try {
        appConfig = loadAppConfig(process.env);
        model = getModelPlugin();
        if (model.id !== "gpt" && model.id !== "deepseek") throw new Error(`Unsupported model id: ${model.id}`);
        provider = model.id;
        await promptStore.load(provider);
        await loadMemeRuntime();
    } catch (error) {
        logs.dispose();
        setConsoleLogOutputEnabled(true);
        throw error;
    }

    let qqState: QqConnectionState = "disconnected";
    let shuttingDown = false;
    let startPromise: Promise<void> | undefined;
    let shutdownPromise: Promise<void> | undefined;
    let memberRepository: SqliteMemberRepository | undefined;

    let control: ReturnType<typeof createTenBotControl> | undefined;
    let unsubscribeProviderErrors: () => void = () => undefined;
    let bot: ReturnType<typeof createQqBot>;
    try {
        bot = createQqBot((state) => {
            qqState = state;
            control?.publishStatus();
        });
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
        const prompt = promptStore.get(provider);
        const memes = getMemeRuntimeSnapshot();
        const configured = provider === "gpt"
            ? Boolean(appConfig.ai.gpt.apiKey && appConfig.ai.gpt.baseURL)
            : Boolean(appConfig.ai.deepseek.apiKey);
        return {
            qq: qqState,
            provider: {
                id: provider,
                model: model.model,
                webSearch: model.capabilities.webSearch,
                configured,
                reasoningEffort: model.reasoningEffort,
                verbosity: model.verbosity,
            },
            activeCycles: getActiveReplyCycleCount(),
            contextConversations: getRecentContextConversationCount(),
            runtimeConfig: {
                logLevel: appConfig.logging.level,
                botLoopGuardMaxCycles: appConfig.botLoopGuard.maxCycles,
            },
            memes: {
                count: memes.entries.length,
                revision: memes.revision,
                loadedAt: memes.loadedAt,
                path: "src/skills/meme/data/memes.json",
                sampleNames: memes.entries.slice(0, 5).map((entry) => entry.name),
            },
            prompt: {
                provider,
                revision: prompt.revision,
                loadedAt: prompt.loadedAt,
                path: `src/ai/plugins/${provider}/prompt.md`,
                characters: prompt.content.length,
                lines: prompt.content.split(/\r?\n/).length,
            },
            shuttingDown,
        };
    };

    control = createTenBotControl({
        getStatus: status,
        getConfig: () => configStore.getPublicConfig(),
        updateConfig: (patch) => configStore.updatePublicConfig(patch),
        subscribeLogs: (listener) => logs.subscribe(listener),
        async reloadPrompt(requestedProvider): Promise<ReloadResult> {
            const target = requestedProvider ?? provider;
            try {
                const prompt = await promptStore.reload(target);
                logger.info(`[Control] prompt reloaded provider=${target} revision=${prompt.revision}`);
                return { ok: true, message: "Prompt reloaded", loadedAt: prompt.loadedAt, revision: prompt.revision };
            } catch (error) {
                logger.error(`[Control] prompt reload failed provider=${target}`, error);
                return { ok: false, message: "Prompt reload failed; keeping the previous version" };
            }
        },
        async reloadMemes(): Promise<ReloadResult> {
            try {
                const memes = await reloadMemeData();
                logger.info(`[Control] memes reloaded count=${memes.entries.length} revision=${memes.revision}`);
                return { ok: true, message: "Memes reloaded", loadedAt: memes.loadedAt, revision: memes.revision, count: memes.entries.length };
            } catch (error) {
                logger.error("[Control] Meme reload failed; keeping the previous version", error);
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
                    logs.dispose();
                    setConsoleLogOutputEnabled(true);
                }
            })();
            return shutdownPromise;
        },
    });

    unsubscribeProviderErrors = subscribeProviderErrors((signal) => {
        control?.publishEvent({
            type: "provider-error",
            notice: createProviderErrorNotice(signal.provider, signal.model, signal.error),
        });
    });

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
