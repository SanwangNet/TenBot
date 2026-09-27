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
    meme?: string | null;
}

export type QqReplyParseRejectionReason =
    | "invalid-json"
    | "invalid-root"
    | "invalid-messages"
    | "empty-action"
    | "invalid-meme"
    | "invalid-no-reply"
    | "invalid-mentions";

export type QqReplyArgumentsParseResult =
    | { ok: true; action: QQReplyAction }
    | { ok: false; reason: QqReplyParseRejectionReason };

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
function normalizeQQReplyActionDetailed(value: unknown): QqReplyArgumentsParseResult {
    if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "invalid-root" };
    const data = value as Record<string, unknown>;
    const messages = normalizeReplyMessages(data.messages, data.quote);
    const rawMeme = data.meme;
    if (rawMeme !== undefined && rawMeme !== null &&
        (typeof rawMeme !== "string" || rawMeme.length > 255 || /[\r\n\x00-\x1f]/.test(rawMeme))) {
        return { ok: false, reason: "invalid-meme" };
    }
    const meme = typeof rawMeme === "string" && rawMeme.trim() ? rawMeme.trim() : null;
    const containsNoReply = messages.some((message) => message.content === "<NO_REPLY>");
    if (containsNoReply && (messages.length !== 1 || meme !== null)) {
        return { ok: false, reason: "invalid-no-reply" };
    }
    if (!messages.length && !meme) {
        return {
            ok: false,
            reason: Array.isArray(data.messages) || typeof data.content === "string" ? "empty-action" : "invalid-messages",
        };
    }
    if (data.mentions !== undefined &&
        (!Array.isArray(data.mentions) || !data.mentions.every((name) => typeof name === "string"))) {
        return { ok: false, reason: "invalid-mentions" };
    }
    const mentions = ((data.mentions as string[] | undefined) ?? [])
        .map((name) => name.trim()).filter(Boolean);
    const action = meme === null ? { messages, mentions } : { messages, mentions, meme };
    return { ok: true, action };
}

/** Build a fresh semantic action, discarding any transport fields from input. */
export function normalizeQQReplyAction(value: unknown): QQReplyAction | null {
    const result = normalizeQQReplyActionDetailed(value);
    return result.ok ? result.action : null;
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
        "表达最终 QQ 回复意图。messages 放 0～3 条独立文本，每条都有 content 和 quote；meme 为 null 或当前输入“可用表情包文件”列表中的完整文件名（含真实扩展名），最多一个。表情包是正常聊天表达方式之一，可根据语境主动使用，无需等用户点名；吐槽、惊讶、无语、调侃、接梗、明显情绪和轻量回应都可能适合。文字和 meme 可搭配；如果 meme 已能完整表达反应，也可 messages=[] 只发表情，硬回复时同样有效。meme 不占 3 条文本额度，Node 会在文本之后独立发送图片。不要每轮都用、连续机械使用，或在技术解释、严肃问题中强行使用；只依据文件名能可靠表达的含义选择，不要猜图中人物、文字、动作或剧情，也不要改写或虚构文件名。mentions 是整次回复共享的已知群友昵称，仅第一条实际 @。每条 quote 独立选择：auto 由系统按当前会话时序决定（发送延迟期间目标会冻结），none 表示不引用；如果一句话明显对应 Recent Context 中某条消息，优先用 quote.message 并填写对应 [mN]；只是自然补充时用 none；没有特定对象、但延迟发送时可能需要系统帮助避免语义漂移时用 auto。每条最多引用一个目标；想分别回应多条消息时拆成多条回复。只能选当前输入中实际展示的 [mN]，不可自造 mN、暴露或猜真实 QQ 消息 ID，也不要把 [mN] 写进正文。不要填写任何腾讯 API 字段。Reply Judge 的回复门控不会因 meme 改变；软回复仍可在策略允许时输出 <NO_REPLY>，硬回复不能输出 <NO_REPLY>，且至少要有一条文本或一个列表中的 meme。",
    strict: true,
    parameters: {
        type: "object",
        properties: {
            messages: {
                type: "array", minItems: 0, maxItems: MAX_REPLY_MESSAGES,
                items: {
                    type: "object",
                    properties: {
                        content: { type: "string", description: "这条 QQ 回复的文字，可使用 Markdown" },
                        quote: quoteSchema,
                    },
                    required: ["content", "quote"],
                    additionalProperties: false,
                },
                description: "按顺序发送 0～3 条文本；硬回复可为 0 条，但此时必须同时选择列表中的 meme。每条文本可以独立引用一条上下文消息",
            },
            mentions: {
                type: "array", items: { type: "string" },
                description: "真正 @ 的已知群友准确昵称；不需要时为空数组",
            },
            meme: {
                type: ["string", "null"], maxLength: 255,
                description: "null 或当前输入提供的可用表情包完整文件名；最多一个。列表中有自然匹配时可主动选；只能选择现存文件且文件名必须原样含扩展名",
            },
        },
        required: ["messages", "mentions", "meme"],
        additionalProperties: false,
    },
};

export function parseQqReplyArgumentsDetailed(argumentsJson: string): QqReplyArgumentsParseResult {
    let parsed: unknown;
    try { parsed = JSON.parse(argumentsJson); }
    catch { return { ok: false, reason: "invalid-json" }; }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false, reason: "invalid-root" };
    }
    const data = parsed as Record<string, unknown>;
    // Older compatible backends may still produce `content`; the pipeline sees only `messages`.
    return normalizeQQReplyActionDetailed({
        messages: data.messages === undefined && typeof data.content === "string"
            ? [data.content] : data.messages,
        mentions: data.mentions,
        meme: data.meme,
        quote: data.quote,
    });
}

/** Existing fail-closed API retained for callers that only need success or null. */
export function parseQqReplyArguments(argumentsJson: string): QQReplyAction | null {
    const result = parseQqReplyArgumentsDetailed(argumentsJson);
    return result.ok ? result.action : null;
}
