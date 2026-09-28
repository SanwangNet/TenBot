import type { GroupMember, GroupSettings, KnownMember, MemberBotState, MemberRepository } from "./repository.js";

/** Ephemeral fallback and test adapter; production Node configures SQLite at startup. */
export class MemoryMemberRepository implements MemberRepository {
    private readonly members = new Map<string, Map<string, KnownMember>>();
    private readonly groups = new Map<string, GroupSettings>();
    private readonly botStates = new Map<string, MemberBotState>();
    private legacyImportCompleted = false;

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

    async listAll(): Promise<KnownMember[]> {
        return [...this.members.values()].flatMap((group) => [...group.values()].map((member) => ({ ...member })))
            .sort((a, b) => b.lastSeenAt - a.lastSeenAt || a.memberOpenid.localeCompare(b.memberOpenid) || a.groupOpenid.localeCompare(b.groupOpenid));
    }

    async getMemberBotState(groupOpenid: string, memberOpenid: string): Promise<MemberBotState> {
        return { ...(this.botStates.get(botStateKey(groupOpenid, memberOpenid)) ?? defaultBotState(groupOpenid, memberOpenid)) };
    }

    async setPlatformBot(groupOpenid: string, memberOpenid: string, enabled: boolean, at: number): Promise<MemberBotState> {
        const state = this.mutableBotState(groupOpenid, memberOpenid, at);
        state.platformBot = enabled;
        state.updatedAt = at;
        return { ...state };
    }

    async setManualBot(groupOpenid: string, memberOpenid: string, enabled: boolean, at: number): Promise<MemberBotState> {
        const state = this.mutableBotState(groupOpenid, memberOpenid, at);
        state.manualBot = enabled;
        state.updatedAt = at;
        return { ...state };
    }

    async incrementDetectionMark(groupOpenid: string, memberOpenid: string, at: number, threshold: number): Promise<MemberBotState> {
        const state = this.mutableBotState(groupOpenid, memberOpenid, at);
        state.detectionMarks++;
        state.lastDetectionAt = at;
        state.updatedAt = at;
        if (state.detectionMarks >= threshold) state.autoBot = true;
        return { ...state };
    }

    async resetDetectionMarks(groupOpenid: string, memberOpenid: string, at: number): Promise<MemberBotState> {
        const state = this.mutableBotState(groupOpenid, memberOpenid, at);
        state.detectionMarks = 0;
        state.lastDetectionAt = null;
        state.autoBot = false;
        state.updatedAt = at;
        return { ...state };
    }

    async listMarkedBots(): Promise<GroupMember[]> {
        const output: GroupMember[] = [];
        for (const member of await this.listAll()) {
            const state = await this.getMemberBotState(member.groupOpenid, member.memberOpenid);
            if (state.platformBot || state.manualBot || state.autoBot) output.push({ ...member, ...state });
        }
        return output;
    }

    async listGroupMembers(groupOpenid: string): Promise<GroupMember[]> {
        const members = [...(this.members.get(groupOpenid)?.values() ?? [])];
        return Promise.all(members.map(async (member) => ({
            ...member,
            ...await this.getMemberBotState(groupOpenid, member.memberOpenid),
        })));
    }

    async findGroupMember(groupOpenid: string, memberOpenid: string): Promise<GroupMember | null> {
        const member = this.members.get(groupOpenid)?.get(memberOpenid);
        return member ? { ...member, ...await this.getMemberBotState(groupOpenid, memberOpenid) } : null;
    }

    async wasLegacyAutomatedPeerImportCompleted(): Promise<boolean> { return this.legacyImportCompleted; }

    async markLegacyAutomatedPeerImportCompleted(): Promise<void> { this.legacyImportCompleted = true; }

    async ensureGroup(groupOpenid: string, at: number, displayName?: string): Promise<GroupSettings> {
        const current = this.groups.get(groupOpenid);
        const name = cleanGroupName(displayName) ?? current?.displayName;
        const group: GroupSettings = {
            groupOpenid,
            repliesEnabled: current?.repliesEnabled ?? true,
            firstSeenAt: current?.firstSeenAt ?? at,
            lastSeenAt: Math.max(current?.lastSeenAt ?? at, at),
            updatedAt: at,
            ...(name ? { displayName: name } : {}),
            memberCount: this.members.get(groupOpenid)?.size ?? 0,
        };
        this.groups.set(groupOpenid, group);
        return { ...group };
    }

    async getGroupSettings(groupOpenid: string): Promise<GroupSettings | null> {
        const group = this.groups.get(groupOpenid);
        return group ? { ...group, memberCount: this.members.get(groupOpenid)?.size ?? 0 } : null;
    }

    async setGroupRepliesEnabledForGroup(groupOpenid: string, enabled: boolean, at: number): Promise<GroupSettings | null> {
        const group = this.groups.get(groupOpenid);
        if (!group) return null;
        const updated = { ...group, repliesEnabled: enabled, updatedAt: at, memberCount: this.members.get(groupOpenid)?.size ?? 0 };
        this.groups.set(groupOpenid, updated);
        return { ...updated };
    }

    async listGroups(): Promise<GroupSettings[]> {
        return [...this.groups.values()].map((group) => ({
            ...group,
            memberCount: this.members.get(group.groupOpenid)?.size ?? 0,
        })).sort((left, right) => right.lastSeenAt - left.lastSeenAt || left.groupOpenid.localeCompare(right.groupOpenid));
    }

    private mutableBotState(groupOpenid: string, memberOpenid: string, at: number): MemberBotState {
        const key = botStateKey(groupOpenid, memberOpenid);
        let state = this.botStates.get(key);
        if (!state) {
            state = { ...defaultBotState(groupOpenid, memberOpenid), createdAt: at, updatedAt: at };
            this.botStates.set(key, state);
        }
        return state;
    }
}

function cleanGroupName(value: string | undefined): string | undefined {
    const name = value?.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
    return name || undefined;
}

function botStateKey(groupOpenid: string, memberOpenid: string): string { return `${groupOpenid}\u0000${memberOpenid}`; }

function defaultBotState(groupOpenid: string, memberOpenid: string): MemberBotState {
    return { groupOpenid, memberOpenid, platformBot: false, manualBot: false, autoBot: false,
        detectionMarks: 0, lastDetectionAt: null, createdAt: 0, updatedAt: 0 };
}
