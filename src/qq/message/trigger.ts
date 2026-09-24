import type { NormalizedQqMessage } from "./normalize-message.js";

export type TriggerKind = "hard-mention" | "name-soft" | "active-soft";

export interface MessageTriggerDecision {
    isGroup: boolean;
    isAtBot: boolean;
    mentionedByName: boolean;
    activeConversation: boolean;
    hardTrigger: boolean;
    shouldReply: boolean;
    allowNoReply: boolean;
    triggerKind: TriggerKind | null;
}

export function decideMessageTrigger(
    message: NormalizedQqMessage,
    activeConversation: boolean,
): MessageTriggerDecision {
    const isGroup =
        message.kind === "group" ||
        message.eventType === "GROUP_MESSAGE_CREATE" ||
        message.eventType === "GROUP_AT_MESSAGE_CREATE";

    const isAtBot =
        message.eventType === "GROUP_AT_MESSAGE_CREATE" ||
        message.mentions.some((mention) => mention.isSelf);

    const mentionedByName = message.content.includes("小尘");
    const hardTrigger = isAtBot;
    const softTrigger = mentionedByName || activeConversation;
    const shouldReply = !isGroup || hardTrigger || softTrigger;
    const triggerKind: TriggerKind | null = !isGroup ? null
        : isAtBot ? "hard-mention"
          : mentionedByName ? "name-soft"
            : activeConversation ? "active-soft" : null;

    return {
        isGroup,
        isAtBot,
        mentionedByName,
        activeConversation,
        hardTrigger,
        shouldReply,
        allowNoReply: isGroup && !hardTrigger,
        triggerKind,
    };
}

export function isOnlyQQFace(content: string): boolean {
    if (!content.includes("<faceType=")) {
        return false;
    }

    return content.replace(/<faceType=[^>]*>/g, "").trim().length === 0;
}

export function wantsVision(
    input: string,
    isAtBot: boolean,
    mentionedByName: boolean,
    hasRecentImage: boolean,
): boolean {
    if (!isAtBot && !mentionedByName) {
        return false;
    }

    const explicitVisionPatterns = [
        /看(?:看)?(?:这个|这张|这图|图片)/,
        /看下(?:这个|这张|这图|图片)/,
        /这(?:个|张)图/,
        /图里/,
        /图片里/,
        /识别(?:一下)?/,
        /认得出/,
        /看得出/,
        /这是什么/,
    ];

    if (explicitVisionPatterns.some((pattern) => pattern.test(input))) {
        return true;
    }

    if (!hasRecentImage) {
        return false;
    }

    return [
        /哪个(?:是)?/,
        /哪一个/,
        /谁(?:是)?/,
        /哪位/,
        /哪张/,
        /这个(?:呢|是)?/,
        /那个(?:呢|是)?/,
    ].some((pattern) => pattern.test(input));
}
