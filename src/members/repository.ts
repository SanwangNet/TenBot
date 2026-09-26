export interface KnownMember {
    groupOpenid: string;
    memberOpenid: string;
    username: string;
    role?: string;
    firstSeenAt: number;
    lastSeenAt: number;
    updatedAt: number;
}

export interface MemberRepository {
    upsertMember(member: KnownMember): Promise<void>;
    findByOpenid(groupOpenid: string, memberOpenid: string): Promise<KnownMember | null>;
    findByUsername(groupOpenid: string, username: string): Promise<KnownMember[]>;
    listByGroup(groupOpenid: string): Promise<KnownMember[]>;
    listAll(): Promise<KnownMember[]>;
}
