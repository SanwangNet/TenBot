import { createModelPluginFromConfig, replaceModelPlugin } from "./ai/model-registry.js";
import type { ModelPlugin } from "./ai/model-plugin.js";
import type { AppConfig } from "./config/config-types.js";

export interface RuntimeConfigSnapshot {
    readonly appConfig: AppConfig;
    readonly model: ModelPlugin;
    readonly revision: number;
    readonly loadedAt: string;
    readonly lastSuccessAt: string;
}

export type ModelPluginBuilder = (config: AppConfig) => ModelPlugin;
export type ModelPluginSwap = (plugin: ModelPlugin, revision: number) => void;

/** Builds a complete plugin first, then swaps the pointer used by future Attempts. */
export class RuntimeConfigSnapshotStore {
    private snapshot: RuntimeConfigSnapshot;

    constructor(
        initialConfig: AppConfig,
        private readonly buildPlugin: ModelPluginBuilder = createModelPluginFromConfig,
        private readonly swapPlugin: ModelPluginSwap = replaceModelPlugin,
    ) {
        this.snapshot = this.buildSnapshot(initialConfig, 1);
        this.swapPlugin(this.snapshot.model, this.snapshot.revision);
    }

    get(): RuntimeConfigSnapshot {
        return this.snapshot;
    }

    replace(config: AppConfig): RuntimeConfigSnapshot {
        const next = this.buildSnapshot(config, this.snapshot.revision + 1);
        this.swapPlugin(next.model, next.revision);
        this.snapshot = next;
        return next;
    }

    private buildSnapshot(config: AppConfig, revision: number): RuntimeConfigSnapshot {
        const model = this.buildPlugin(config);
        if (model.id !== config.ai.provider) throw new Error("模型提供商快照与配置不一致");
        const loadedAt = new Date().toISOString();
        return Object.freeze({ appConfig: config, model, revision, loadedAt, lastSuccessAt: loadedAt });
    }
}
