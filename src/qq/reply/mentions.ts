import { findMembersByName } from "../conversation/known-members.js";
import type { NormalizedQqMessage } from "../message/normalize-message.js";

async function mentionTag(message: NormalizedQqMessage, name: string): Promise<string> {
    const matches = await findMembersByName(message.groupId, name);
    const member = matches.length === 1 ? matches[0] : null;
    return member && /^[A-Za-z0-9_-]+$/.test(member.memberOpenid)
        ? '<qqbot-at-user id="' + member.memberOpenid + '" />'
        : "@" + name.replace(/[<>]/g, "");
}

export async function renderMentions(
    message: NormalizedQqMessage,
    text: string,
): Promise<{ sendText: string; contextText: string }> {
    const pattern = /<mention>([^<]{1,64})<\/mention>/g;
    const matches = [...text.matchAll(pattern)];
    const tags = await Promise.all(matches.map((match) => mentionTag(message, match[1].trim())));
    let cursor = 0;
    let sendText = "";
    for (const [index, match] of matches.entries()) {
        sendText += text.slice(cursor, match.index) + tags[index];
        cursor = match.index! + match[0].length;
    }
    sendText += text.slice(cursor);
    return {
        sendText,
        contextText: text.replace(pattern, (_match, name: string) => "@" + name.trim()),
    };
}

export async function renderStructuredMentions(
    message: NormalizedQqMessage,
    content: string,
    mentions: string[],
): Promise<{ sendText: string; contextText: string }> {
    const safeContent = content.replace(/<qqbot-at-user\b[^>]*\/?>/gi, "");
    const rendered = await renderMentions(message, safeContent);
    const names = [...new Set(mentions.map((name) => name.trim()).filter(Boolean))]
        .filter((name) => !safeContent.includes("<mention>" + name + "</mention>"));
    const tags = await Promise.all(names.map((name) => mentionTag(message, name)));
    return {
        sendText: [...tags, rendered.sendText].filter(Boolean).join(" "),
        contextText: [...names.map((name) => "@" + name), rendered.contextText]
            .filter(Boolean).join(" "),
    };
}
