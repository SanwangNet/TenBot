import type { LogEntry } from "../shared/logger.js";
import type { QqConnectionState } from "../control/runtime-status.js";
import type { ModelVerbosity, ReasoningEffort } from "../ai/model-plugin.js";
import type { LogLevel } from "../shared/logger.js";
import type { SettingsField } from "./state.js";

export const PAGE_LABELS = {
    overview: "总览",
    model: "模型",
    prompt: "提示词",
    memes: "梗数据",
    conversations: "对话",
    "automated-peers": "自动账号",
    logs: "日志",
    settings: "设置",
} as const;

export const PAGES = Object.keys(PAGE_LABELS) as Array<keyof typeof PAGE_LABELS>;

export function pageLabel(page: keyof typeof PAGE_LABELS): string {
    return PAGE_LABELS[page];
}

export function providerLabel(provider: string): string {
    return provider === "gpt" ? "GPT" : provider === "deepseek" ? "DeepSeek" : provider;
}

export function connectionLabel(state: QqConnectionState): string {
    return {
        connecting: "连接中",
        connected: "已连接",
        disconnected: "未连接",
        error: "异常",
    }[state];
}

export function connectionColor(state: QqConnectionState): "green" | "yellow" | "red" {
    return state === "connected" ? "green" : state === "error" ? "red" : "yellow";
}

export function reasoningLabel(value: ReasoningEffort | undefined): string {
    if (value === undefined) return "默认";
    return {
        none: "关闭",
        low: "低",
        medium: "中",
        high: "高",
        xhigh: "极高",
    }[value] ?? "默认";
}

export function verbosityLabel(value: ModelVerbosity | undefined): string {
    return value ? ({
        low: "简洁",
        medium: "标准",
        high: "详细",
    }[value] ?? "默认") : "默认";
}

export function enabledLabel(enabled: boolean): string {
    return enabled ? "已启用" : "未启用";
}

export function configuredLabel(configured: boolean): string {
    return configured ? "已配置" : "未配置";
}

export function logLevelLabel(level: LogLevel): string {
    return ({ debug: "调试", info: "信息", error: "错误" } satisfies Record<LogLevel, string>)[level];
}

export function settingsFieldLabel(field: SettingsField): string {
    return ({
        aiProvider: "模型提供商",
        "gpt.model": "GPT 模型",
        "gpt.reasoningEffort": "GPT 推理强度",
        "gpt.verbosity": "GPT 输出详细度",
        "deepseek.model": "DeepSeek 模型",
        "deepseek.reasoningEffort": "DeepSeek 推理强度",
        logLevel: "日志级别",
        "botLoopGuard.maxCycles": "自动互聊上限",
    } satisfies Record<SettingsField, string>)[field];
}

const SCOPE_LABELS: Record<string, string> = {
    GROUP: "群聊",
    Context: "上下文",
    Trigger: "触发",
    Cycle: "周期",
    Meme: "梗",
    AI: "模型",
    Reply: "回复",
    Peer: "账号",
    BotLoop: "互聊保护",
};

export function formatTuiLogText(entry: LogEntry): string {
    return entry.text.replace(/\[([^\]]+)\]/g, (whole, scope: string) => {
        const label = SCOPE_LABELS[scope];
        return label ? `[${label}]` : whole;
    });
}

export function formatTime(timestamp: string): string {
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime())
        ? "--:--:--"
        : date.toLocaleTimeString("zh-CN", { hour12: false });
}

export function formatDateTime(timestamp: string): string {
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime())
        ? "未知"
        : date.toLocaleString("zh-CN", { hour12: false });
}
