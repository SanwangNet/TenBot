/** The model expresses QQ reply intent here; Tencent transport fields stay in Node. */
export type QuotePreference = "auto" | "trigger" | "none";

export interface QQReplyAction {
    messages: string[];
    mentions: string[];
    quote: QuotePreference;
}

export const MAX_REPLY_MESSAGES = 3;

export function normalizeReplyMessages(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value
        .filter((message): message is string => typeof message === "string")
        .map((message) => message.trim())
        .filter(Boolean)
        .slice(0, MAX_REPLY_MESSAGES);
}

/** Build a fresh semantic action, discarding any transport fields from input. */
export function normalizeQQReplyAction(value: unknown): QQReplyAction | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const data = value as Record<string, unknown>;
    const messages = normalizeReplyMessages(data.messages);
    if (!messages.length || (messages.length > 1 && messages.includes("<NO_REPLY>"))) return null;
    if (data.mentions !== undefined &&
        (!Array.isArray(data.mentions) || !data.mentions.every((name) => typeof name === "string"))) return null;
    const mentions = ((data.mentions as string[] | undefined) ?? [])
        .map((name) => name.trim()).filter(Boolean);
    const quote: QuotePreference = data.quote === "trigger" || data.quote === "none"
        ? data.quote : "auto";
    return { messages, mentions, quote };
}

export const qqReplyTool = {
    type: "function" as const,
    name: "qq_reply",
    description:
        "表达最终 QQ 回复意图。messages 放 1～3 条文字，默认一条；只有自然聊天明显适合补一句时才使用多条。可用 mentions 指定要 @ 的已知群友准确昵称，用 quote 请求引用触发消息。不要为了使用功能而强行 @、引用或拆分消息。不要填写 QQ ID、消息 ID 或腾讯 API 字段。若决定不回复，直接输出 <NO_REPLY>，不要调用工具。",
    strict: true,
    parameters: {
        type: "object",
        properties: {
            messages: {
                type: "array", items: { type: "string" }, minItems: 1,
                maxItems: MAX_REPLY_MESSAGES,
                description: "按顺序发送的 QQ 文字消息；通常只有一条，可使用 Markdown",
            },
            mentions: {
                type: "array", items: { type: "string" },
                description: "真正 @ 的已知群友准确昵称；不需要时为空数组",
            },
            quote: {
                type: "string", enum: ["auto", "trigger", "none"],
                description: "引用偏好；实际是否引用由 Node 根据消息时序决定",
            },
        },
        required: ["messages", "mentions", "quote"],
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
