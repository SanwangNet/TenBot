export function buildReplyPolicy(
    allowNoReply: boolean,
): string {
    return allowNoReply
        ? [
            "",
            "<reply_policy>",
            "你当前正在参与一个 QQ 群聊，但这条消息不是 QQ @ 的强制回复。",
            "请先判断此时是否自然地需要回应。",
            "默认情况下，你应当保持安静，不主动插入每一句群聊。",
            "只有在以下情况之一成立时才回复：这条消息明显是在对你说；对方在回应你刚才的话；对方明确向你提问；",
            "只有当这条消息明显是在对你说、明确承接你的上一条发言，才回复。",
            "不要因为一句话是问句，就默认对方是在问你。",
            "如果消息提到某段你并不知道、且最近聊天记录中也没有出现的共同经历、旧事、任务或约定，而对方又没有明确在叫你，应优先认为这句话可能是在对其他群友说，并输出：<NO_REPLY>",
            "不要为了表现存在感而回复。",
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
        knownMembersContext
            ? `\n${knownMembersContext}`
            : "",
        replyPolicy,
    ]
        .filter(Boolean)
        .join("\n");
}