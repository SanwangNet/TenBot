import "dotenv/config";

import { getModelPlugin } from "./ai/model-registry.js";
import type { ModelPlugin } from "./ai/model-plugin.js";
import { getPromptStore, type PromptProvider } from "./ai/prompt-store.js";
import { createTenBotControl, type ReloadResult, type TenBotControl } from "./control/tenbot-control.js";
import type { RuntimeStatus } from "./control/runtime-status.js";
import { LogBuffer } from "./control/log-buffer.js";
import { SqliteMemberRepository } from "./members/sqlite-repository.js";
import { MemoryMemberRepository } from "./members/memory-repository.js";
import { createQqBot, type QqConnectionState } from "./qq/bot.js";
import { configureMemberRepository } from "./qq/conversation/known-members.js";
import { getRecentContextConversationCount } from "./qq/conversation/recent-context.js";
import { getActiveReplyCycleCount, shutdownReplyCoordinator } from "./qq/reply/coordinator.js";
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
    const promptStore = getPromptStore();
    let model: ModelPlugin;
    let provider: PromptProvider;
    try {
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
            ? Boolean(process.env.CODEX_API_KEY && process.env.CODEX_BASE_URL)
            : Boolean(process.env.DEEPSEEK_API_KEY);
        return {
            qq: qqState,
            provider: { id: provider, model: model.model, webSearch: model.capabilities.webSearch, configured },
            activeCycles: getActiveReplyCycleCount(),
            contextConversations: getRecentContextConversationCount(),
            memes: { count: memes.entries.length, revision: memes.revision, loadedAt: memes.loadedAt },
            prompt: { provider, revision: prompt.revision, loadedAt: prompt.loadedAt },
            shuttingDown,
        };
    };

    control = createTenBotControl({
        getStatus: status,
        subscribeLogs: (listener) => logs.subscribe(listener),
        async reloadPrompt(requestedProvider): Promise<ReloadResult> {
            const target = requestedProvider ?? provider;
            try {
                const prompt = await promptStore.reload(target);
                logger.info(`[Control] prompt reloaded provider=${target} revision=${prompt.revision}`);
                return { ok: true, message: "Prompt reloaded", loadedAt: prompt.loadedAt };
            } catch (error) {
                logger.error(`[Control] prompt reload failed provider=${target}`, error);
                return { ok: false, message: "Prompt reload failed; keeping the previous version" };
            }
        },
        async reloadMemes(): Promise<ReloadResult> {
            try {
                const memes = await reloadMemeData();
                logger.info(`[Control] memes reloaded count=${memes.entries.length} revision=${memes.revision}`);
                return { ok: true, message: "Memes reloaded", loadedAt: memes.loadedAt };
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
                    logs.dispose();
                    setConsoleLogOutputEnabled(true);
                }
            })();
            return shutdownPromise;
        },
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
