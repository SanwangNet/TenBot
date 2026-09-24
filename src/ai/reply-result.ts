import { normalizeQQReplyAction, type QQReplyAction } from "../skills/qq-reply/skill.js";

export type AiResult =
    | { kind: "reply"; action: QQReplyAction }
    | { kind: "no_reply" };

/** Plain output_text uses the same QQReplyAction as qq_reply, without sentence splitting. */
export function normalizeTextReply(content: string): AiResult | null {
    const action = normalizeQQReplyAction({ messages: [content] });
    return action ? { kind: "reply", action } : null;
}
