export interface KnownMember {
    groupOpenid: string;
    memberOpenid: string;
    username: string;
    role?: string;
    firstSeenAt: number;
    lastSeenAt: number;
    updatedAt: number;
}

export interface GroupSettings {
    groupOpenid: string;
    repliesEnabled: boolean;
    firstSeenAt: number;
    lastSeenAt: number;
    updatedAt: number;
    displayName?: string;
    memberCount: number;
}

export interface GroupSettingsRepository {
    ensureGroup(groupOpenid: string, at: number, displayName?: string): Promise<GroupSettings>;
    getGroupSettings(groupOpenid: string): Promise<GroupSettings | null>;
    setGroupRepliesEnabledForGroup(groupOpenid: string, enabled: boolean, at: number): Promise<GroupSettings | null>;
    listGroups(): Promise<GroupSettings[]>;
}

export interface MemberBotState {
    groupOpenid: string;
    memberOpenid: string;
    platformBot: boolean;
    manualBot: boolean;
    autoBot: boolean;
    detectionMarks: number;
    lastDetectionAt: number | null;
    createdAt: number;
    updatedAt: number;
}

export interface GroupMember extends KnownMember {
    platformBot: boolean;
    manualBot: boolean;
    autoBot: boolean;
    detectionMarks: number;
    lastDetectionAt: number | null;
}

export interface MemberRepository extends GroupSettingsRepository {
    upsertMember(member: KnownMember): Promise<void>;
    getMemberBotState(groupOpenid: string, memberOpenid: string): Promise<MemberBotState>;
    setPlatformBot(groupOpenid: string, memberOpenid: string, enabled: boolean, at: number): Promise<MemberBotState>;
    setManualBot(groupOpenid: string, memberOpenid: string, enabled: boolean, at: number): Promise<MemberBotState>;
    incrementDetectionMark(groupOpenid: string, memberOpenid: string, at: number, threshold: number): Promise<MemberBotState>;
    resetDetectionMarks(groupOpenid: string, memberOpenid: string, at: number): Promise<MemberBotState>;
    listMarkedBots(): Promise<GroupMember[]>;
    listGroupMembers(groupOpenid: string): Promise<GroupMember[]>;
    findGroupMember(groupOpenid: string, memberOpenid: string): Promise<GroupMember | null>;
    wasLegacyAutomatedPeerImportCompleted(): Promise<boolean>;
    markLegacyAutomatedPeerImportCompleted(at: number): Promise<void>;
    findByOpenid(groupOpenid: string, memberOpenid: string): Promise<KnownMember | null>;
    findByUsername(groupOpenid: string, username: string): Promise<KnownMember[]>;
    listByGroup(groupOpenid: string): Promise<KnownMember[]>;
    listAll(): Promise<KnownMember[]>;
}
