/** The model expresses QQ reply intent here; Tencent transport fields stay in Node. */
export type QuotePreference = { mode: "auto" | "none"; ref: null } |
    { mode: "message"; ref: string };

export interface QQReplyMessage {
    content: string;
    quote: QuotePreference;
}

export interface QQReplyAction {
    messages: QQReplyMessage[];
    mentions: string[];
}

export const MAX_REPLY_MESSAGES = 3;

function normalizeQuote(value: unknown): QuotePreference {
    if (value === "none") return { mode: "none", ref: null };
    if (value && typeof value === "object" && !Array.isArray(value)) {
        const choice = value as Record<string, unknown>;
        if (choice.mode === "none" && choice.ref === null) return { mode: "none", ref: null };
        if (choice.mode === "message" && typeof choice.ref === "string") {
            return { mode: "message", ref: choice.ref };
        }
    }
    // Legacy "trigger" and missing or malformed preferences use auto safely.
    return { mode: "auto", ref: null };
}

/** Accept old string messages only at this boundary; the rest of the pipeline sees one shape. */
export function normalizeReplyMessages(value: unknown, legacyQuote?: unknown): QQReplyMessage[] {
    if (!Array.isArray(value)) return [];
    const messages: QQReplyMessage[] = [];
    for (const item of value) {
        if (messages.length === MAX_REPLY_MESSAGES) break;
        const old = typeof item === "string";
        const data = item && typeof item === "object" && !Array.isArray(item)
            ? item as Record<string, unknown> : undefined;
        const content = old ? item : data?.content;
        if (typeof content !== "string" || !content.trim()) continue;
        messages.push({
            content: content.trim(),
            quote: old ? messages.length === 0 ? normalizeQuote(legacyQuote) : { mode: "none", ref: null }
                : normalizeQuote(data?.quote),
        });
    }
    return messages;
}

/** Build a fresh semantic action, discarding any transport fields from input. */
export function normalizeQQReplyAction(value: unknown): QQReplyAction | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const data = value as Record<string, unknown>;
    const messages = normalizeReplyMessages(data.messages, data.quote);
    if (!messages.length || (messages.length > 1 && messages.some((message) => message.content === "<NO_REPLY>"))) return null;
    if (data.mentions !== undefined &&
        (!Array.isArray(data.mentions) || !data.mentions.every((name) => typeof name === "string"))) return null;
    const mentions = ((data.mentions as string[] | undefined) ?? [])
        .map((name) => name.trim()).filter(Boolean);
    return { messages, mentions };
}

const quoteSchema = {
    type: "object",
    properties: {
        mode: { type: "string", enum: ["auto", "none", "message"] },
        ref: { type: ["string", "null"], description: "message 模式填写当前上下文的 mN；其他模式填 null" },
    },
    required: ["mode", "ref"],
    additionalProperties: false,
} as const;

export const qqReplyTool = {
    type: "function" as const,
    name: "qq_reply",
    description:
        "表达最终 QQ 回复意图。messages 放 1～3 条，每条都有独立的 content 和 quote；mentions 是整次回复共享的已知群友昵称，仅第一条实际 @。每条 quote.auto 让系统按会话时序决定引用，quote.none 不引用；明确回答某条 QQ 消息时用 quote.message 和当前上下文的 [mN] ref。只能选当前上下文提供的 ref，不要在正文写 mN。不要填写 QQ ID 或腾讯 API 字段。若决定不回复，直接输出 <NO_REPLY>。",
    strict: true,
    parameters: {
        type: "object",
        properties: {
            messages: {
                type: "array", minItems: 1, maxItems: MAX_REPLY_MESSAGES,
                items: {
                    type: "object",
                    properties: {
                        content: { type: "string", description: "这条 QQ 回复的文字，可使用 Markdown" },
                        quote: quoteSchema,
                    },
                    required: ["content", "quote"],
                    additionalProperties: false,
                },
                description: "按顺序发送的 1～3 条 QQ 回复；每条可以独立引用一条上下文消息",
            },
            mentions: {
                type: "array", items: { type: "string" },
                description: "真正 @ 的已知群友准确昵称；不需要时为空数组",
            },
        },
        required: ["messages", "mentions"],
        additionalProperties: false,
    },
};

export function parseQqReplyArguments(argumentsJson: string): QQReplyAction | null {
    let parsed: unknown;
    try { parsed = JSON.parse(argumentsJson); } catch { return null; }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const data = parsed as Record<string, unknown>;
    // Older compatible backends may still produce `content`; the pipeline sees only `messages`.
    return normalizeQQReplyAction({
        messages: data.messages === undefined && typeof data.content === "string"
            ? [data.content] : data.messages,
        mentions: data.mentions,
        quote: data.quote,
    });
}
