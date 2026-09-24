import type { KnownMember, MemberRepository } from "./repository.js";

/** Ephemeral fallback and test adapter; production Node configures SQLite at startup. */
export class MemoryMemberRepository implements MemberRepository {
    private readonly members = new Map<string, Map<string, KnownMember>>();

    async upsertMember(member: KnownMember): Promise<void> {
        let group = this.members.get(member.groupOpenid);
        if (!group) {
            group = new Map();
            this.members.set(member.groupOpenid, group);
        }
        const existing = group.get(member.memberOpenid);
        group.set(member.memberOpenid, {
            ...member,
            role: member.role ?? existing?.role,
            firstSeenAt: existing?.firstSeenAt ?? member.firstSeenAt,
        });
    }

    async findByOpenid(groupOpenid: string, memberOpenid: string): Promise<KnownMember | null> {
        const member = this.members.get(groupOpenid)?.get(memberOpenid);
        return member ? { ...member } : null;
    }

    async findByUsername(groupOpenid: string, username: string): Promise<KnownMember[]> {
        return (await this.listByGroup(groupOpenid)).filter((member) => member.username === username);
    }

    async listByGroup(groupOpenid: string): Promise<KnownMember[]> {
        return [...(this.members.get(groupOpenid)?.values() ?? [])]
            .map((member) => ({ ...member }))
            .sort((a, b) => b.lastSeenAt - a.lastSeenAt || a.memberOpenid.localeCompare(b.memberOpenid));
    }
}
