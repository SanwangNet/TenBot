import type { AddMemberBotDetectionEvidence, MemberBotDetectionEvidence, MemberBotDetectionObservation } from "./detection-evidence.js";

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
    /** @deprecated Heuristic observations are not Bot identity. Always false in repository reads. */
    autoBot: boolean;
    detectionMarks: number;
    lastDetectionAt: number | null;
    createdAt: number;
    updatedAt: number;
}

export interface GroupMember extends KnownMember {
    platformBot: boolean;
    manualBot: boolean;
    /** @deprecated Heuristic observations are not Bot identity. Always false in repository reads. */
    autoBot: boolean;
    detectionMarks: number;
    lastDetectionAt: number | null;
    /** Present on the member detail response; contains active evidence only. */
    activeDetectionEvidence?: MemberBotDetectionEvidence[];
}

export interface MemberRepository extends GroupSettingsRepository {
    upsertMember(member: KnownMember): Promise<void>;
    getMemberBotState(groupOpenid: string, memberOpenid: string): Promise<MemberBotState>;
    setPlatformBot(groupOpenid: string, memberOpenid: string, enabled: boolean, at: number): Promise<MemberBotState>;
    setManualBot(groupOpenid: string, memberOpenid: string, enabled: boolean, at: number): Promise<MemberBotState>;
    addDetectionEvidence(evidence: AddMemberBotDetectionEvidence): Promise<MemberBotDetectionEvidence>;
    addDetectionEvidenceIfCooldownElapsed(evidence: AddMemberBotDetectionEvidence, cooldownMs: number): Promise<MemberBotDetectionEvidence | null>;
    listActiveDetectionEvidence(groupOpenid: string, memberOpenid: string, at?: number): Promise<MemberBotDetectionEvidence[]>;
    getActiveDetectionCount(groupOpenid: string, memberOpenid: string, at?: number): Promise<number>;
    clearDetectionEvidence(groupOpenid: string, memberOpenid: string): Promise<MemberBotState>;
    recordDetectionObservation(observation: MemberBotDetectionObservation): Promise<boolean>;
    listRecentDetectionObservations(groupOpenid: string, memberOpenid: string, since: number, through: number, at?: number): Promise<MemberBotDetectionObservation[]>;
    pruneExpiredDetectionEvidence(at?: number): Promise<void>;
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
