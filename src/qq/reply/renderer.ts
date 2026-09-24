import type { QQReplyAction } from "../../skills/qq-reply/skill.js";
import type { NormalizedQqMessage } from "../message/normalize-message.js";
import { renderStructuredMentions } from "./mentions.js";

export interface RenderedQQReply {
    sendText: string;
    contextText: string;
}

/** Resolve semantic text and nicknames into QQ Markdown; media assets can join here later. */
export async function prepareAiReply(
    message: NormalizedQqMessage,
    action: QQReplyAction,
    index: number,
): Promise<RenderedQQReply> {
    const content = action.messages[index].content;
    // Mentions belong to the first QQ message. Later inline tags stay readable text.
    const safeContent = index === 0 ? content : content.replace(
        /<mention>([^<]{1,64})<\/mention>/g,
        (_tag, name: string) => "@" + name.trim(),
    );
    return renderStructuredMentions(message, safeContent, index === 0 ? action.mentions : []);
}
