export type QuotePreference = "auto" | "trigger" | "none";

export interface QqReplyAction {
    content: string;
    mentions: string[];
    quote: QuotePreference;
}

export type AiResult =
    | { kind: "reply"; source: "qq_reply" | "text"; action: QqReplyAction }
    | { kind: "no_reply" };

/** Semantic reply intent only; QQ identifiers and transport fields stay in Node. */
export const qqReplyTool = {
    type: "function" as const,
    name: "qq_reply",
    description:
        "最终回复 QQ 消息时使用。content 是要发送的 Markdown 文本；如需真正 @ 已知群友，把准确昵称放入 mentions；quote 选择 auto、trigger 或 none。不要填写 QQ ID、msg_id 或原始 API 字段。若决定不回复，直接输出 <NO_REPLY>，不要调用此工具。",
    strict: true,
    parameters: {
        type: "object",
        properties: {
            content: { type: "string", description: "实际发送的回复内容，可使用 Markdown" },
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
        required: ["content", "mentions", "quote"],
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
    if (typeof data.content !== "string" || !data.content.trim()) {
        return null;
    }
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
        content: data.content,
        mentions: mentions.map((name) => name.trim()).filter(Boolean),
        quote,
    };
}
