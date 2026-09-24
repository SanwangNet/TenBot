export type QuotePreference = "auto" | "trigger" | "none";

export interface QqReplyAction {
    messages: string[];
    mentions: string[];
    quote: QuotePreference;
}

export type AiResult =
    | { kind: "reply"; source: "qq_reply" | "text"; action: QqReplyAction }
    | { kind: "no_reply" };

export const MAX_REPLY_MESSAGES = 3;

export function normalizeReplyMessages(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value
        .filter((message): message is string => typeof message === "string")
        .map((message) => message.trim())
        .filter(Boolean)
        .slice(0, MAX_REPLY_MESSAGES);
}

/** Plain output_text is always one QQ message, regardless of punctuation or newlines. */
export function normalizeTextReply(content: string): AiResult | null {
    const message = content.trim();
    return message
        ? { kind: "reply", source: "text", action: { messages: [message], mentions: [], quote: "auto" } }
        : null;
}

/** Semantic reply intent only; QQ identifiers and transport fields stay in Node. */
export const qqReplyTool = {
    type: "function" as const,
    name: "qq_reply",
    description:
        "最终回复 QQ 消息时使用。messages 默认只放一条；仅在自然聊天确实适合说完再补一句时偶尔放两条，极少三条，不要频繁拆分。知识解释、联网搜索、代码、表格、列表和完整 Markdown 通常保持一条，不要按标点拆分。如需真正 @ 已知群友，把准确昵称放入 mentions；quote 选择 auto、trigger 或 none。不要填写 QQ ID、msg_id 或原始 API 字段。若决定不回复，直接输出 <NO_REPLY>，不要调用此工具。",
    strict: true,
    parameters: {
        type: "object",
        properties: {
            messages: {
                type: "array",
                items: { type: "string" },
                minItems: 1,
                maxItems: MAX_REPLY_MESSAGES,
                description: "依次发送的 QQ 消息，每条可使用 Markdown；默认一条",
            },
            mentions: {
                type: "array",
                items: { type: "string" },
                description: "需要真正 @ 的已知群友准确昵称；不需要时为空数组",
            },
            quote: {
                type: "string",
                enum: ["auto", "trigger", "none"],
                description: "引用偏好；auto 由本地根据新消息决定",
            },
        },
        required: ["messages", "mentions", "quote"],
        additionalProperties: false,
    },
};

export function parseQqReplyArguments(argumentsJson: string): QqReplyAction | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(argumentsJson);
    } catch {
        return null;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return null;
    }

    const data = parsed as Record<string, unknown>;
    const rawMessages = data.messages === undefined && typeof data.content === "string"
        ? [data.content]
        : data.messages;
    if (!Array.isArray(rawMessages)) {
        return null;
    }
    const messages = normalizeReplyMessages(rawMessages);
    if (!messages.length || (messages.length > 1 && messages.includes("<NO_REPLY>"))) return null;
    if (data.mentions !== undefined &&
        (!Array.isArray(data.mentions) ||
            !data.mentions.every((name) => typeof name === "string"))) {
        return null;
    }

    const quote = data.quote === "trigger" || data.quote === "none"
        ? data.quote
        : "auto";
    const mentions = (data.mentions as string[] | undefined) ?? [];

    return {
        messages,
        mentions: mentions.map((name) => name.trim()).filter(Boolean),
        quote,
    };
}
