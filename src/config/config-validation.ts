import type { ModelVerbosity, ReasoningEffort } from "../ai/model-plugin.js";
import type {
    AppConfig,
    ImageGenerationConfig,
    ImageGenerationQuality,
    ImageGenerationSize,
    ImageOutputFormat,
    ModelProviderId,
    PublicConfig,
    PublicConfigPatch,
} from "./config-types.js";
import type { FrontMode } from "../front/wake-level.js";
import { validateBotTimeZone } from "../ai/time-context.js";
import { getImageModelCapabilities, imageSizeSupportedByCapabilities, parseImageDimensions } from "../ai/image-capabilities.js";
import { isIP } from "node:net";

export const DEFAULT_GPT_MODEL = "gpt-6-sol";
export const DEFAULT_DEEPSEEK_MODEL = "deepseek-flash";
export const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export const DEFAULT_GPT_REASONING_EFFORT: ReasoningEffort = "high";
export const DEFAULT_GPT_VERBOSITY: ModelVerbosity = "high";
export const DEFAULT_DEEPSEEK_REASONING_EFFORT: ReasoningEffort = "high";
export const DEFAULT_BOT_LOOP_GUARD_MAX_CYCLES = 4;
export const DEFAULT_REPLY_JUDGE_TIMEOUT_MS = 5_000;
export const DEFAULT_REPLY_JUDGE_IPO_FALLBACK_TO_MAIN = true;
export const DEFAULT_REPLY_JUDGE_TURN_WAIT_MS = 20_000;
export const DEFAULT_MEME_SEND_MAX_EDGE = 160;
export const DEFAULT_IMAGE_GENERATION_CONFIG: ImageGenerationConfig = {
    enabled: false,
    dailyLimit: 3,
    provider: "gpt",
    model: "",
    quality: "low",
    size: "1024x1024",
    outputFormat: "png",
};
export const DEFAULT_FRONT_MODE: FrontMode = "legacy";
export const DEFAULT_WEB_HOST = "127.0.0.1";
export const DEFAULT_WEB_PORT = 3000;
const MIN_REPLY_JUDGE_TIMEOUT_MS = 1_000;
const MAX_REPLY_JUDGE_TIMEOUT_MS = 30_000;
const MIN_REPLY_JUDGE_TURN_WAIT_MS = 1_000;
const MAX_REPLY_JUDGE_TURN_WAIT_MS = 60_000;
const MIN_MEME_SEND_MAX_EDGE = 32;
const MAX_MEME_SEND_MAX_EDGE = 1_024;

const REASONING_EFFORTS: readonly ReasoningEffort[] = ["none", "low", "medium", "high", "xhigh"];
const VERBOSITIES: readonly ModelVerbosity[] = ["low", "medium", "high"];
const IMAGE_QUALITIES: readonly ImageGenerationQuality[] = ["low", "medium", "high", "xhigh", "max", "auto", "standard", "hd"];
const IMAGE_OUTPUT_FORMATS: readonly ImageOutputFormat[] = ["png", "jpeg", "webp"];

export function parseBotAdminIds(value: string | undefined): readonly string[] {
    const normalized = (value ?? "").replace(/&#x20;/gi, " ");
    const ids = normalized.split(",").map((id) => id.trim().toUpperCase()).filter(Boolean);
    for (const id of ids) {
        if (!/^(?:[A-F0-9]{8}|[A-F0-9]{64})$/.test(id)) {
            throw new Error("BOT_ADMIN_IDS entries must be 8-character display IDs or 64-character SHA-256 hashes");
        }
    }
    return [...new Set(ids)];
}

export function parseBotLoopGuardMaxCycles(value: string | undefined): number {
    if (value === undefined || value.trim() === "") return DEFAULT_BOT_LOOP_GUARD_MAX_CYCLES;
    if (!/^\d+$/.test(value.trim())) {
        throw new Error("BOT_LOOP_GUARD_MAX_CYCLES 必须是大于等于 1 的整数");
    }
    const parsed = Number(value.trim());
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new Error("BOT_LOOP_GUARD_MAX_CYCLES 必须是大于等于 1 的整数");
    }
    return parsed;
}

export function parseWebHost(value: string | undefined): string {
    const host = value?.trim() || DEFAULT_WEB_HOST;
    const ipv6Address = host.split("%")[0] ?? "";
    const ipv6Zone = host.includes("%") ? host.slice(host.indexOf("%") + 1) : undefined;
    const labels = host.endsWith(".") ? host.slice(0, -1).split(".") : host.split(".");
    const validHostname = host.length <= 253 && labels.length > 0 && labels.every((label) =>
        label.length > 0 && label.length <= 63 && /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(label));
    const validIpv6 = isIP(ipv6Address) === 6 && (ipv6Zone === undefined || /^[a-zA-Z0-9_.-]+$/.test(ipv6Zone));
    if (isIP(host) !== 0 || validHostname || validIpv6) return host;
    throw new Error("WEB_HOST must be a valid IP address or hostname");
}

export function parseWebPort(value: string | undefined): number {
    if (value === undefined || value.trim() === "") return DEFAULT_WEB_PORT;
    const normalized = value.trim();
    if (!/^\d+$/.test(normalized)) throw new Error("WEB_PORT must be an integer between 1 and 65535");
    const port = Number(normalized);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
        throw new Error("WEB_PORT must be an integer between 1 and 65535");
    }
    return port;
}

function parseMemeSendMaxEdge(value: string | undefined): number | null {
    if (value === undefined || value.trim() === "") return DEFAULT_MEME_SEND_MAX_EDGE;
    if (value.trim().toLowerCase() === "original") return null;
    const normalized = value.trim();
    if (!/^\d+$/.test(normalized)) throw new Error("MEME_SEND_MAX_EDGE must be original or an integer between 32 and 1024");
    const edge = Number(normalized);
    if (!Number.isSafeInteger(edge) || edge < MIN_MEME_SEND_MAX_EDGE || edge > MAX_MEME_SEND_MAX_EDGE) {
        throw new Error("MEME_SEND_MAX_EDGE must be original or an integer between 32 and 1024");
    }
    return edge;
}

export function parseReasoningEffort(value: string | undefined, fallback: ReasoningEffort): ReasoningEffort {
    const normalized = value?.trim().toLowerCase();
    return REASONING_EFFORTS.includes(normalized as ReasoningEffort)
        ? normalized as ReasoningEffort
        : fallback;
}

export function parseVerbosity(value: string | undefined, fallback: ModelVerbosity): ModelVerbosity {
    const normalized = value?.trim().toLowerCase();
    return VERBOSITIES.includes(normalized as ModelVerbosity)
        ? normalized as ModelVerbosity
        : fallback;
}

export function parseModelName(value: string | undefined, fallback: string): string {
    const normalized = value?.trim();
    return normalized && normalized.length <= 128 && !/[\r\n]/.test(normalized) ? normalized : fallback;
}

function parseProvider(value: string | undefined): ModelProviderId {
    const normalized = value?.trim().toLowerCase() || "gpt";
    if (normalized === "gpt" || normalized === "deepseek") return normalized;
    throw new Error(`不支持的 AI_PROVIDER: ${normalized}`);
}

function parseReplyJudgeProvider(value: string | undefined): "openai-compatible" | undefined {
    const normalized = value?.trim().toLowerCase();
    if (!normalized) return undefined;
    return normalized === "openai-compatible" ? normalized : undefined;
}

function parseFrontMode(value: string | undefined): FrontMode {
    const normalized = value?.trim().toLowerCase() || DEFAULT_FRONT_MODE;
    if (normalized === "legacy" || normalized === "judge") return normalized;
    throw new Error("FRONT_MODE must be legacy or judge");
}

function parseReplyJudgeBaseURL(value: string | undefined): string | undefined {
    const normalized = value?.trim();
    if (!normalized) return undefined;
    try {
        const url = new URL(normalized);
        if (
            (url.protocol !== "https:" && url.protocol !== "http:") ||
            url.username ||
            url.password ||
            url.search ||
            url.hash
        ) return undefined;
        return url.toString().replace(/\/$/, "");
    } catch {
        return undefined;
    }
}

function parseReplyJudgeTimeout(value: string | undefined): number {
    if (!value?.trim()) return DEFAULT_REPLY_JUDGE_TIMEOUT_MS;
    if (!/^\d+$/.test(value.trim())) return DEFAULT_REPLY_JUDGE_TIMEOUT_MS;
    const timeoutMs = Number(value.trim());
    return Number.isSafeInteger(timeoutMs) && timeoutMs >= MIN_REPLY_JUDGE_TIMEOUT_MS && timeoutMs <= MAX_REPLY_JUDGE_TIMEOUT_MS
        ? timeoutMs
        : DEFAULT_REPLY_JUDGE_TIMEOUT_MS;
}

export function loadAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
    const provider = parseProvider(env.AI_PROVIDER);
    const frontMode = parseFrontMode(env.FRONT_MODE);
    const replyJudge = {
        provider: parseReplyJudgeProvider(env.REPLY_JUDGE_PROVIDER),
        model: parseModelName(env.REPLY_JUDGE_MODEL, ""),
        baseURL: parseReplyJudgeBaseURL(env.REPLY_JUDGE_BASE_URL),
        apiKey: env.REPLY_JUDGE_API_KEY?.trim() || undefined,
        timeoutMs: parseReplyJudgeTimeout(env.REPLY_JUDGE_TIMEOUT_MS),
        fallbackToMainOnInvalidOutput: parseReplyJudgeIpoFallback(env.REPLY_JUDGE_IPO_FALLBACK_TO_MAIN),
        turnWaitMs: parseReplyJudgeTurnWait(env.REPLY_JUDGE_TURN_WAIT_MS),
    };
    if (frontMode === "judge") {
        const missing = [
            !replyJudge.provider && "REPLY_JUDGE_PROVIDER",
            !replyJudge.model && "REPLY_JUDGE_MODEL",
            !replyJudge.baseURL && "REPLY_JUDGE_BASE_URL",
            !replyJudge.apiKey && "REPLY_JUDGE_API_KEY",
        ].filter((field): field is string => Boolean(field));
        if (missing.length) {
            throw new Error(`FRONT_MODE=judge requires valid ${missing.join(", ")}`);
        }
    }
    return {
        frontMode,
        botTimeZone: validateBotTimeZone(env.BOT_TIME_ZONE),
        botAdminIds: parseBotAdminIds(env.BOT_ADMIN_IDS),
        memeSendMaxEdge: parseMemeSendMaxEdge(env.MEME_SEND_MAX_EDGE),
        qq: {
            appId: env.QQBOT_APP_ID,
            appSecret: env.QQBOT_APP_SECRET,
        },
        ai: {
            provider,
            gpt: {
                apiKey: env.CODEX_API_KEY,
                baseURL: env.CODEX_BASE_URL?.trim() || undefined,
                model: parseModelName(env.CODEX_MODEL, DEFAULT_GPT_MODEL),
                reasoningEffort: parseReasoningEffort(env.CODEX_REASONING_EFFORT, DEFAULT_GPT_REASONING_EFFORT),
                verbosity: parseVerbosity(env.CODEX_VERBOSITY, DEFAULT_GPT_VERBOSITY),
            },
            deepseek: {
                apiKey: env.DEEPSEEK_API_KEY,
                baseURL: env.DEEPSEEK_BASE_URL?.trim() || DEFAULT_DEEPSEEK_BASE_URL,
                model: parseModelName(env.DEEPSEEK_MODEL, DEFAULT_DEEPSEEK_MODEL),
                reasoningEffort: parseReasoningEffort(env.DEEPSEEK_REASONING_EFFORT, DEFAULT_DEEPSEEK_REASONING_EFFORT),
            },
        },
        image: {
            enabled: parseImageGenerationEnabled(env.IMAGE_GENERATION_ENABLED),
            dailyLimit: parseImageGenerationDailyLimit(env.IMAGE_GENERATION_DAILY_LIMIT),
            provider: parseImageGenerationProvider(env.IMAGE_GENERATION_PROVIDER),
            model: parseModelName(env.IMAGE_GENERATION_MODEL, DEFAULT_IMAGE_GENERATION_CONFIG.model),
            quality: parseImageGenerationQuality(env.IMAGE_GENERATION_QUALITY),
            size: parseImageGenerationSize(env.IMAGE_GENERATION_SIZE),
            outputFormat: parseImageOutputFormat(env.IMAGE_GENERATION_OUTPUT_FORMAT),
        },
        replyJudge,
        web: { host: parseWebHost(env.WEB_HOST), port: parseWebPort(env.WEB_PORT) },
        botLoopGuard: {
            maxCycles: parseBotLoopGuardMaxCycles(env.BOT_LOOP_GUARD_MAX_CYCLES),
        },
    };
}

export function toPublicConfig(config: AppConfig): PublicConfig {
    return {
        aiProvider: config.ai.provider,
        image: { ...config.image },
        memeSendMaxEdge: config.memeSendMaxEdge,
        replyJudge: {
            model: config.replyJudge.model ?? "",
            timeoutMs: config.replyJudge.timeoutMs,
            fallbackToMainOnInvalidOutput: config.replyJudge.fallbackToMainOnInvalidOutput,
            turnWaitMs: config.replyJudge.turnWaitMs,
            ...(config.replyJudge.provider ? { provider: config.replyJudge.provider } : {}),
        },
        gpt: {
            model: config.ai.gpt.model,
            reasoningEffort: config.ai.gpt.reasoningEffort,
            verbosity: config.ai.gpt.verbosity,
            configured: Boolean(config.ai.gpt.apiKey?.trim() && config.ai.gpt.baseURL?.trim()),
        },
        deepseek: {
            model: config.ai.deepseek.model,
            reasoningEffort: config.ai.deepseek.reasoningEffort,
            configured: Boolean(config.ai.deepseek.apiKey?.trim()),
        },
        botLoopGuard: {
            maxCycles: config.botLoopGuard.maxCycles,
        },
    };
}

export function validatePublicConfigPatch(patch: PublicConfigPatch): string {
    switch (patch.field) {
        case "aiProvider":
            if (patch.value !== "gpt" && patch.value !== "deepseek") throw new Error("模型提供商配置无效");
            return "AI_PROVIDER";
        case "memeSendMaxEdge":
            if (patch.value !== null && (!Number.isSafeInteger(patch.value) || patch.value < MIN_MEME_SEND_MAX_EDGE || patch.value > MAX_MEME_SEND_MAX_EDGE)) {
                throw new Error("表情包发送最大边长必须选择原始尺寸或 32 到 1024 之间的整数");
            }
            return "MEME_SEND_MAX_EDGE";
        case "image":
            validateImageGenerationConfig(patch.value);
            return "IMAGE_GENERATION_ENABLED";
        case "gpt.model":
        case "deepseek.model":
        case "replyJudge.model": {
            const model = patch.value.trim();
            if (!model || model.length > 128 || /[\r\n]/.test(model)) {
                throw new Error("模型名称不能为空、不能换行，且长度不能超过 128 个字符");
            }
            if (patch.field === "gpt.model") return "CODEX_MODEL";
            if (patch.field === "deepseek.model") return "DEEPSEEK_MODEL";
            return "REPLY_JUDGE_MODEL";
        }
        case "replyJudge.timeoutMs":
            if (!Number.isSafeInteger(patch.value) || patch.value < MIN_REPLY_JUDGE_TIMEOUT_MS || patch.value > MAX_REPLY_JUDGE_TIMEOUT_MS) {
                throw new Error("Reply Judge 超时时间必须是 1000 到 30000 毫秒之间的安全整数");
            }
            return "REPLY_JUDGE_TIMEOUT_MS";
        case "replyJudge.fallbackToMainOnInvalidOutput":
            if (typeof patch.value !== "boolean") throw new Error("REPLY_JUDGE_IPO_FALLBACK_TO_MAIN must be true or false");
            return "REPLY_JUDGE_IPO_FALLBACK_TO_MAIN";
        case "replyJudge.turnWaitMs":
            if (!Number.isSafeInteger(patch.value) || patch.value < MIN_REPLY_JUDGE_TURN_WAIT_MS || patch.value > MAX_REPLY_JUDGE_TURN_WAIT_MS) {
                throw new Error("REPLY_JUDGE_TURN_WAIT_MS must be an integer between 1000 and 60000");
            }
            return "REPLY_JUDGE_TURN_WAIT_MS";
        case "gpt.reasoningEffort":
        case "deepseek.reasoningEffort":
            if (!REASONING_EFFORTS.includes(patch.value)) throw new Error("推理强度配置无效");
            return patch.field === "gpt.reasoningEffort" ? "CODEX_REASONING_EFFORT" : "DEEPSEEK_REASONING_EFFORT";
        case "gpt.verbosity":
            if (!VERBOSITIES.includes(patch.value)) throw new Error("输出详细度配置无效");
            return "CODEX_VERBOSITY";
        case "botLoopGuard.maxCycles":
            if (!Number.isSafeInteger(patch.value) || patch.value < 1) {
                throw new Error("Bot 连续交互上限必须是大于等于 1 的整数");
            }
            return "BOT_LOOP_GUARD_MAX_CYCLES";
    }
}

function parseReplyJudgeIpoFallback(value: string | undefined): boolean {
    const normalized = value?.trim().toLowerCase();
    if (!normalized) return DEFAULT_REPLY_JUDGE_IPO_FALLBACK_TO_MAIN;
    if (normalized === "true") return true;
    if (normalized === "false") return false;
    throw new Error("REPLY_JUDGE_IPO_FALLBACK_TO_MAIN must be true or false");
}

function parseReplyJudgeTurnWait(value: string | undefined): number {
    if (value === undefined || value.trim() === "") return DEFAULT_REPLY_JUDGE_TURN_WAIT_MS;
    const normalized = value.trim();
    if (!/^\d+$/.test(normalized)) throw new Error("REPLY_JUDGE_TURN_WAIT_MS must be an integer between 1000 and 60000");
    const milliseconds = Number(normalized);
    if (!Number.isSafeInteger(milliseconds) || milliseconds < MIN_REPLY_JUDGE_TURN_WAIT_MS || milliseconds > MAX_REPLY_JUDGE_TURN_WAIT_MS) {
        throw new Error("REPLY_JUDGE_TURN_WAIT_MS must be an integer between 1000 and 60000");
    }
    return milliseconds;
}

/** Checks transport input shape and primitive types before semantic validation. */
export function parsePublicConfigPatch(value: unknown): PublicConfigPatch | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length !== 2 || !Object.hasOwn(record, "field") || !Object.hasOwn(record, "value")) return undefined;
    const field = record.field;
    const patchValue = record.value;
    if (typeof field !== "string") return undefined;

    switch (field) {
        case "aiProvider":
        case "gpt.reasoningEffort":
        case "gpt.verbosity":
        case "deepseek.reasoningEffort":
            return typeof patchValue === "string" ? { field, value: patchValue } as PublicConfigPatch : undefined;
        case "gpt.model":
        case "deepseek.model":
        case "replyJudge.model":
            return typeof patchValue === "string" ? { field, value: patchValue } as PublicConfigPatch : undefined;
        case "replyJudge.timeoutMs":
        case "botLoopGuard.maxCycles":
            return typeof patchValue === "number" ? { field, value: patchValue } as PublicConfigPatch : undefined;
        case "replyJudge.fallbackToMainOnInvalidOutput":
            return typeof patchValue === "boolean" ? { field, value: patchValue } : undefined;
        case "memeSendMaxEdge":
            return patchValue === null || typeof patchValue === "number" ? { field, value: patchValue } : undefined;
        case "image":
            return parseImageGenerationConfigPatch(patchValue);
        case "replyJudge.turnWaitMs":
            return typeof patchValue === "number" ? { field, value: patchValue } : undefined;
        default:
            return undefined;
    }
}

export function patchValueAsString(patch: PublicConfigPatch): string {
    if (patch.field === "image") throw new Error("Image configuration is stored as multiple environment values");
    if (patch.field === "memeSendMaxEdge" && patch.value === null) return "original";
    return String(patch.value).trim();
}

/** Converts a validated public patch into the managed .env values it writes. */
export function publicConfigPatchEnvValues(
    patch: PublicConfigPatch,
    validateImageConfig: (config: ImageGenerationConfig) => void = validateImageGenerationConfig,
): Record<string, string> {
    if (patch.field === "image") {
        validateImageConfig(patch.value);
        return {
            IMAGE_GENERATION_ENABLED: String(patch.value.enabled),
            IMAGE_GENERATION_DAILY_LIMIT: String(patch.value.dailyLimit),
            IMAGE_GENERATION_PROVIDER: patch.value.provider,
            IMAGE_GENERATION_MODEL: patch.value.model,
            IMAGE_GENERATION_QUALITY: patch.value.quality,
            IMAGE_GENERATION_SIZE: patch.value.size,
            IMAGE_GENERATION_OUTPUT_FORMAT: patch.value.outputFormat,
        };
    }
    const key = validatePublicConfigPatch(patch);
    return { [key]: patchValueAsString(patch) };
}

export function validateImageGenerationConfigShape(config: ImageGenerationConfig): void {
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("AI 绘图配置无效");
    if (typeof config.enabled !== "boolean") throw new Error("AI 绘图开关必须是布尔值");
    if (!Number.isSafeInteger(config.dailyLimit) || config.dailyLimit < 0) throw new Error("每人每日默认生图次数必须是非负整数");
    if (config.provider !== "gpt") throw new Error("AI 绘图目前只支持复用 GPT 上游");
    if (typeof config.model !== "string" || config.model.length > 128 || /[\u0000-\u001f\u007f]/.test(config.model)) {
        throw new Error("绘图模型 ID 不能包含控制字符且长度不能超过 128 个字符");
    }
    if (config.enabled && !config.model.trim()) throw new Error("启用 AI 绘图前必须选择绘图模型");
    if (!IMAGE_QUALITIES.includes(config.quality)) throw new Error("AI 绘图质量配置无效");
    if (typeof config.size !== "string" || config.size.length > 11 ||
        (config.size !== "auto" && !parseImageDimensions(config.size))) {
        throw new Error("AI 绘图尺寸配置无效");
    }
    if (!IMAGE_OUTPUT_FORMATS.includes(config.outputFormat)) throw new Error("AI 绘图格式配置无效");
}

export function validateImageGenerationConfig(
    config: ImageGenerationConfig,
    capabilities?: ReturnType<typeof getImageModelCapabilities>,
): void {
    validateImageGenerationConfigShape(config);
    if (!config.enabled) return;

    const profile = capabilities ?? getImageModelCapabilities(config.model);
    if (!profile.quality.includes(config.quality)) {
        throw new Error(`模型 ${config.model} 的参数档案不支持质量 ${config.quality}`);
    }
    if (!imageSizeSupportedByCapabilities(config.size, profile)) {
        throw new Error(`模型 ${config.model} 的参数档案不支持尺寸 ${config.size}`);
    }
    if (!profile.outputFormats.includes(config.outputFormat)) {
        throw new Error(`模型 ${config.model} 的参数档案不支持输出格式 ${config.outputFormat}`);
    }
}

function parseImageGenerationEnabled(value: string | undefined): boolean {
    const normalized = value?.trim().toLowerCase();
    if (!normalized) return DEFAULT_IMAGE_GENERATION_CONFIG.enabled;
    if (normalized === "true") return true;
    if (normalized === "false") return false;
    throw new Error("IMAGE_GENERATION_ENABLED must be true or false");
}

export function parseImageGenerationDailyLimit(value: string | undefined): number {
    if (value === undefined || value.trim() === "") return DEFAULT_IMAGE_GENERATION_CONFIG.dailyLimit;
    const normalized = value.trim();
    if (!/^\d+$/.test(normalized)) throw new Error("IMAGE_GENERATION_DAILY_LIMIT 必须是非负整数");
    const parsed = Number(normalized);
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("IMAGE_GENERATION_DAILY_LIMIT 必须是非负安全整数");
    return parsed;
}

function parseImageGenerationProvider(value: string | undefined): "gpt" {
    const normalized = value?.trim().toLowerCase();
    if (!normalized || normalized === "gpt") return "gpt";
    throw new Error("IMAGE_GENERATION_PROVIDER currently supports only gpt");
}

function parseImageGenerationQuality(value: string | undefined): ImageGenerationQuality {
    const normalized = value?.trim().toLowerCase();
    return IMAGE_QUALITIES.includes(normalized as ImageGenerationQuality)
        ? normalized as ImageGenerationQuality
        : DEFAULT_IMAGE_GENERATION_CONFIG.quality;
}

function parseImageGenerationSize(value: string | undefined): ImageGenerationSize {
    const normalized = value?.trim().toLowerCase();
    return normalized === "auto" || (normalized && parseImageDimensions(normalized))
        ? normalized as ImageGenerationSize
        : DEFAULT_IMAGE_GENERATION_CONFIG.size;
}

function parseImageOutputFormat(value: string | undefined): ImageOutputFormat {
    const normalized = value?.trim().toLowerCase();
    return IMAGE_OUTPUT_FORMATS.includes(normalized as ImageOutputFormat)
        ? normalized as ImageOutputFormat
        : DEFAULT_IMAGE_GENERATION_CONFIG.outputFormat;
}

function parseImageGenerationConfigPatch(value: unknown): PublicConfigPatch | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const legacyFields = ["enabled", "provider", "model", "quality", "size", "outputFormat"];
    const fields = ["enabled", "dailyLimit", "provider", "model", "quality", "size", "outputFormat"];
    const isLegacyShape = Object.keys(record).length === legacyFields.length && legacyFields.every((field) => Object.hasOwn(record, field));
    const hasCurrentShape = Object.keys(record).length === fields.length && fields.every((field) => Object.hasOwn(record, field));
    if (!isLegacyShape && !hasCurrentShape) return undefined;
    const dailyLimit = isLegacyShape ? DEFAULT_IMAGE_GENERATION_CONFIG.dailyLimit : record.dailyLimit;
    if (typeof record.enabled !== "boolean" || typeof dailyLimit !== "number" || typeof record.provider !== "string" ||
        typeof record.model !== "string" || typeof record.quality !== "string" ||
        typeof record.size !== "string" || typeof record.outputFormat !== "string") return undefined;
    return { field: "image", value: { ...record, dailyLimit } as unknown as ImageGenerationConfig };
}
