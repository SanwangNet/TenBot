export function buildReplyPolicy(allowNoReply: boolean): string {
    return allowNoReply
        ? [
              "",
              "<reply_policy>",
              "你当前正在参与一个 QQ 群聊，但这条消息不是 QQ @ 的强制回复。",
              "请自行判断此时作为普通群友是否自然地应该回应。",
              "如果这条消息是在直接对你说、继续与你有关的话题、回应你的发言、向你提问，或正常情况下你会自然接这句话，就直接正常回复。",
              "如果只是提到了“小尘”但实际不是在和你说话，或者群友已经开始聊与你无关的话题、彼此交流、随手发言，或此时保持安静更自然，只输出：<NO_REPLY>",
              "你一般应保持安静，可以以“非必要不说话”的标准来判定是否回应。",
              "你的性格应保持清冷，不要过于热情，使用过多“~”此类字符。",
              "如果决定不回复，不要联网、不要调用工具，也不要输出任何其他文字。",
              "</reply_policy>",
          ].join("\n")
        : "";
}

export function buildAiInput(
    chatInput: string,
    knownMembersContext: string,
    replyPolicy: string,
): string {
    return [
        chatInput,
        knownMembersContext ? `\n${knownMembersContext}` : "",
        replyPolicy,
    ]
        .filter(Boolean)
        .join("\n");
}
