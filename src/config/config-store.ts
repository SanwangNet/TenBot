import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ConfigStore, ConfigUpdateResult, PublicConfig, PublicConfigPatch } from "./config-types.js";
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
        return "";
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
    let queue: Promise<ConfigUpdateResult> = Promise.resolve({
        ok: true,
        requiresRestart: false,
        changedFields: [],
        message: "",
    });

    const readCurrentEnvironment = (document: string): NodeJS.ProcessEnv => ({
        ...environment,
        ...parseEnvDocument(document),
    });

    const getPublicConfig = (): PublicConfig => {
        const document = readEnvSync(envPath);
        return toPublicConfig(loadAppConfig(readCurrentEnvironment(document)));
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
                requiresRestart: true,
                changedFields: [patch.field],
                message: "配置已保存，将在重启 TenBot 后生效。",
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
        getPublicConfig,
        updatePublicConfig(patch) {
            const next = queue.then(() => update(patch), () => update(patch));
            queue = next;
            return next;
        },
    };
}
