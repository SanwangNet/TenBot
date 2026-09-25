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
    memeContext = "",
): string {
    return [
        chatInput,
        knownMembersContext
            ? `\n${knownMembersContext}`
            : "",
        memeContext ? "<meme_context>\n" + memeContext + "\n</meme_context>\n" +
            "\u8fd9\u4e9b\u90fd\u662f\u672c\u5730\u68c0\u7d22\u7684\u5019\u9009\u63d0\u793a\uff0c\u8bf7\u7ed3\u5408\u5b8c\u6574\u804a\u5929\u81ea\u884c\u5224\u65ad\uff1b\u53ef\u4ee5\u53c2\u8003\u4e00\u4e2a\u6216\u591a\u4e2a\uff0c\u4e5f\u53ef\u4ee5\u5168\u90e8\u5ffd\u7565\uff0c\u4e0d\u8981\u4e3a\u4e86\u547d\u4e2d\u800c\u5f3a\u884c\u7528\u6897\u3002STRONG \u8868\u793a\u5339\u914d\u4fe1\u53f7\u8f83\u5f3a\uff1bWEAK \u8868\u793a\u53ef\u80fd\u53ea\u662f\u5b57\u9762\u91cd\u5408\uff0c\u4e0d\u76f8\u5173\u5c31\u5ffd\u7565\u3002\u672c\u5730\u8d44\u6599\u8db3\u591f\u65f6\u4e0d\u8981\u4e3a\u540c\u4e00\u6897\u91cd\u590d\u67e5\u8be2\uff1b\u7528\u6237\u8981\u6c42\u6838\u5b9e\u6216\u8be2\u95ee\u6700\u65b0\u4f20\u64ad\u60c5\u51b5\u65f6\u518d\u67e5\u8be2\u3002" : "",
        replyPolicy,
    ]
        .filter(Boolean)
        .join("\n");
}
