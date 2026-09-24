import { MemoryMemberRepository } from "../../members/memory-repository.js";
import type { KnownMember, MemberRepository } from "../../members/repository.js";
import { logger, truncateLogText } from "../../shared/logger.js";
import type { NormalizedQqMessage } from "../message/normalize-message.js";

let repository: MemberRepository = new MemoryMemberRepository();

/** The Node entry point injects SQLite; a future Worker entry point can inject D1. */
export function configureMemberRepository(next: MemberRepository): void {
    repository = next;
}

function roleName(role?: string): string {
    if (role === "owner") return "群主";
    if (role === "admin" || role === "administrator") return "管理员";
    return "成员";
}

async function learn(groupOpenid: string, memberOpenid: string, username: string, role?: string): Promise<void> {
    try {
        const previous = await repository.findByOpenid(groupOpenid, memberOpenid);
        const now = Date.now();
        await repository.upsertMember({
            groupOpenid, memberOpenid, username, role,
            firstSeenAt: previous?.firstSeenAt ?? now,
            lastSeenAt: now,
            updatedAt: now,
        });
        if (!previous) {
            logger.info("[Members] learned " + truncateLogText(username, 60) + " (" + roleName(role) + ")");
        } else {
            if (previous.username !== username) {
                logger.info("[Members] renamed " + truncateLogText(previous.username, 60) +
                    " -> " + truncateLogText(username, 60));
            }
            if (role !== undefined && role !== previous.role) {
                logger.info("[Members] role " + truncateLogText(username, 60) + " " +
                    (previous.role ?? "member") + " -> " + role);
            }
        }
    } catch (error) {
        logger.error("[Members] persistence error", error);
    }
}

export async function rememberKnownMember(message: NormalizedQqMessage): Promise<void> {
    if (message.kind !== "group" || !message.groupId) return;
    if (!message.authorIsBot && message.author && message.author.is_you !== true && message.author.isYou !== true) {
        const id = message.author.member_openid ?? message.author.memberOpenid ?? message.author.id;
        const name = message.author.username ?? message.author.nickname;
        const role = message.author.member_role ?? message.author.memberRole;
        if (typeof id === "string" && id && typeof name === "string" && name) {
            await learn(message.groupId, id, name, typeof role === "string" ? role : undefined);
        }
    }
    for (const mention of message.mentions) {
        if (!mention.isBot && !mention.isSelf && mention.memberOpenid && mention.username) {
            await learn(message.groupId, mention.memberOpenid, mention.username, mention.role);
        }
    }
}

export async function getKnownMembers(message: NormalizedQqMessage): Promise<KnownMember[]> {
    if (message.kind !== "group" || !message.groupId) return [];
    try {
        return await repository.listByGroup(message.groupId);
    } catch (error) {
        logger.error("[Members] list error", error);
        return [];
    }
}

export async function getKnownMemberNameById(groupOpenid: string | undefined, memberOpenid: string): Promise<string | undefined> {
    if (!groupOpenid) return undefined;
    try {
        return (await repository.findByOpenid(groupOpenid, memberOpenid))?.username;
    } catch (error) {
        logger.error("[Members] lookup error", error);
        return undefined;
    }
}

export async function findMembersByName(groupOpenid: string | undefined, username: string): Promise<KnownMember[]> {
    if (!groupOpenid) return [];
    try {
        return await repository.findByUsername(groupOpenid, username);
    } catch (error) {
        logger.error("[Members] lookup error", error);
        return [];
    }
}

export async function buildKnownMembersContext(message: NormalizedQqMessage): Promise<string> {
    const members = (await getKnownMembers(message)).slice(0, 20);
    if (!members.length) return "";
    const counts = new Map<string, number>();
    const seen = new Map<string, number>();
    for (const member of members) counts.set(member.username, (counts.get(member.username) ?? 0) + 1);
    const lines = members.map((member) => {
        const ordinal = (seen.get(member.username) ?? 0) + 1;
        seen.set(member.username, ordinal);
        const duplicate = (counts.get(member.username) ?? 0) > 1
            ? "；同名成员 " + ordinal + "/" + counts.get(member.username) : "";
        return member.username + "（" + roleName(member.role) + duplicate + "）";
    });
    return [
        "<known_group_members>", ...lines, "</known_group_members>", "",
        "<mention_capability>",
        "上面是你目前认识的群友。",
        "如果确实需要真正 @ 某个已知群友，请在 qq_reply 的 mentions 中填写列表里的准确昵称。",
        "例如需要 @ 尘柒喵时，mentions 填 [\"尘柒喵\"]。",
        "只有真正需要 @ 对方时才填写 mentions，不要每次提到名字都 @。",
        "不要填写不在已知群友列表里的人。",
        "</mention_capability>",
    ].join("\n");
}
