interface KnownMember {
    memberOpenid: string;
    username: string;
    role?: string;
    lastSeenAt: number;
}

const MAX_KNOWN_MEMBERS = 50;

const groups = new Map<
    string,
    Map<string, KnownMember>
>();

function getGroupMembers(
    message: NormalizedQqMessage,
): Map<string, KnownMember> | null {
    const groupId = message.groupId;

    if (!groupId) {
        return null;
    }

    let members =
        groups.get(groupId);

    if (!members) {
        members =
            new Map<
                string,
                KnownMember
            >();

        groups.set(
            groupId,
            members,
        );
    }

    return members;
}

/*
 * 每次有人在群里说话，就更新一次。
 */
export function rememberKnownMember(
    message: NormalizedQqMessage,
): void {
    const members =
        getGroupMembers(message);

    const author = message.author;

    if (!members || !author) {
        return;
    }

    if (author.bot === true) {
        return;
    }

    const memberOpenid =
        author.member_openid ??
        author.memberOpenid ??
        author.id;

    const username =
        author.username ??
        author.nickname;

    if (
        typeof memberOpenid !==
            "string" ||
        !memberOpenid ||
        typeof username !==
            "string" ||
        !username
    ) {
        return;
    }

    members.set(
        memberOpenid,
        {
            memberOpenid,
            username,
            role:
                author.member_role ??
                author.memberRole,
            lastSeenAt:
                Date.now(),
        },
    );

    /*
     * 防止无限增长。
     * 超过上限时删除最久没出现的人。
     */
    if (
        members.size >
        MAX_KNOWN_MEMBERS
    ) {
        const oldest =
            [...members.values()]
                .sort(
                    (a, b) =>
                        a.lastSeenAt -
                        b.lastSeenAt,
                )[0];

        if (oldest) {
            members.delete(
                oldest.memberOpenid,
            );
        }
    }

    console.log(
        `[Members] ${username} (${memberOpenid})`,
    );
}

export function getKnownMembers(
    message: NormalizedQqMessage,
): KnownMember[] {
    const members =
        getGroupMembers(message);

    if (!members) {
        return [];
    }

    return [
        ...members.values(),
    ].sort(
        (a, b) =>
            b.lastSeenAt -
            a.lastSeenAt,
    );
}

function roleName(
    role?: string,
): string {
    switch (role) {
        case "owner":
            return "群主";

        case "admin":
        case "administrator":
            return "管理员";

        default:
            return "成员";
    }
}

/*
 * 给 GPT 看的群友信息。
 *
 * 不把 member_openid 发给模型，
 * 模型只需要昵称和身份。
 */
export function buildKnownMembersContext(
    message: NormalizedQqMessage,
): string {
    const members =
        getKnownMembers(message)
            .slice(0, 20);

    if (
        members.length === 0
    ) {
        return "";
    }

    const lines =
        members.map(
            (member) =>
                `${member.username}（${roleName(member.role)}）`,
        );

    return [
        "<known_group_members>",
        ...lines,
        "</known_group_members>",
        "",
        "<mention_capability>",
        "上面是你目前认识的群友。",
        "如果确实需要直接点名或提醒其中某个人，你可以使用：<mention>昵称</mention>",
        "例如：<mention>尘柒喵</mention> 你刚才不是这么说的（",
        "只有真正需要 @ 对方时才使用 mention，不要每次提到名字都 @。",
        "不要 mention 不在已知群友列表里的人。",
        "</mention_capability>",
    ].join("\n");
}

/*
 * 根据昵称找群友。
 */
function findMemberByName(
    message: NormalizedQqMessage,
    username: string,
): KnownMember | null {
    const members =
        getKnownMembers(message);

    return (
        members.find(
            (member) =>
                member.username ===
                username,
        ) ??
        null
    );
}

/*
 * GPT：
 * <mention>尘柒喵</mention>
 *
 * ↓
 *
 * QQ：
 * <qqbot-at-user id="xxxx" />
 */
export function renderMentions(
    message: NormalizedQqMessage,
    text: string,
): {
    sendText: string;
    contextText: string;
} {
    const mentionPattern =
        /<mention>([^<]{1,64})<\/mention>/g;

    const sendText =
        text.replace(
            mentionPattern,
            (
                _match,
                rawName: string,
            ) => {
                const name =
                    rawName.trim();

                const member =
                    findMemberByName(
                        message,
                        name,
                    );

                if (!member) {
                    /*
                     * 找不到时不要伪造 @。
                     */
                    return `@${name}`;
                }

                return (
                    `<qqbot-at-user id="` +
                    `${member.memberOpenid}" />`
                );
            },
        );

    /*
     * 存进 recent_context 时不要保存 QQ 协议标签。
     */
    const contextText =
        text.replace(
            mentionPattern,
            (
                _match,
                rawName: string,
            ) =>
                `@${rawName.trim()}`,
        );

    return {
        sendText,
        contextText,
    };
}

import type { NormalizedQqMessage } from "../message/normalize-message.js";
