import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AppConfig, ConfigStore, ConfigUpdateResult, PublicConfig, PublicConfigPatch } from "./config-types.js";
import { loadAppConfig, patchValueAsString, toPublicConfig, validatePublicConfigPatch } from "./config-validation.js";
import { isMissingFile, parseEnvDocument, patchEnvDocument, readEnvDocument, writeFileAtomically } from "./env-document.js";

export interface CreateConfigStoreOptions {
    envPath?: string;
    environment?: NodeJS.ProcessEnv;
    writeFileAtomically?: (filePath: string, content: string) => Promise<void>;
}

function readEnvSync(filePath: string): string {
    try {
        return readFileSync(filePath, "utf8");
    } catch (error) {
        if (isMissingFile(error)) return "";
        throw error;
    }
}

function safeFailure(error: unknown): { message: string; details?: string } {
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
        ? error.code
        : undefined;
    return {
        message: "无法写入 .env，请检查文件权限。",
        details: code === "EACCES" || code === "EPERM" ? `文件操作失败（${code}）` : "文件操作失败",
    };
}

export function createConfigStore(options: CreateConfigStoreOptions = {}): ConfigStore {
    const envPath = resolve(options.envPath ?? ".env");
    const environment = options.environment ?? process.env;
    const write = options.writeFileAtomically ?? writeFileAtomically;
    const initialFileEnv = parseEnvDocument(readEnvSync(envPath));
    const baseEnvironment: NodeJS.ProcessEnv = { ...environment };
    for (const [key, value] of Object.entries(initialFileEnv)) {
        if (baseEnvironment[key] === value) delete baseEnvironment[key];
    }
    let queue: Promise<void> = Promise.resolve();

    function serialize<T>(operation: () => Promise<T>): Promise<T> {
        const next = queue.then(operation, operation);
        queue = next.then(() => undefined, () => undefined);
        return next;
    }

    const readCurrentEnvironment = (document: string): NodeJS.ProcessEnv => ({
        ...baseEnvironment,
        ...parseEnvDocument(document),
    });

    const getAppConfig = (): AppConfig => {
        const document = readEnvSync(envPath);
        return loadAppConfig(readCurrentEnvironment(document));
    };

    const getPublicConfig = (): PublicConfig => {
        return toPublicConfig(getAppConfig());
    };

    const update = async (patch: PublicConfigPatch): Promise<ConfigUpdateResult> => {
        let key: string;
        try {
            key = validatePublicConfigPatch(patch);
        } catch (error) {
            return {
                ok: false,
                requiresRestart: false,
                changedFields: [],
                message: "配置无效",
                details: error instanceof Error ? error.message : "配置值不符合要求",
            };
        }

        try {
            const document = await readEnvDocument(envPath);
            const updated = patchEnvDocument(document, { [key]: patchValueAsString(patch) });
            await write(envPath, updated);
            return {
                ok: true,
                requiresRestart: false,
                changedFields: [patch.field],
                message: "配置已保存。",
            };
        } catch (error) {
            const failure = safeFailure(error);
            return {
                ok: false,
                requiresRestart: false,
                changedFields: [],
                message: failure.message,
                details: failure.details,
            };
        }
    };

    return {
        getAppConfig,
        getEnvPath: () => envPath,
        getPublicConfig,
        updatePublicConfig: (patch) => serialize(() => update(patch)),
    };
}
