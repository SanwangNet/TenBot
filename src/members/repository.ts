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

export type ImageGenerationRequestStatus =
    | "reserved" | "submitted" | "generated" | "succeeded" | "send_failed" | "failed" | "unknown";
export type ImageGenerationStatus = "succeeded" | "size_mismatch";
export type ImageGenerationSendStatus = "pending" | "quoted" | "unquoted" | "failed" | "unknown" | "not_attempted";

export interface ImageGenerationUsage {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    imageTokens?: number;
    textTokens?: number;
}

export interface ImageGenerationRequestRecord extends ImageGenerationUsage {
    requestKey: string;
    groupOpenid: string;
    memberOpenid: string;
    messageId: string;
    dayKey: string;
    status: ImageGenerationRequestStatus;
    model: string;
    size: string;
    quality: string;
    outputFormat: string;
    requestedAt: number;
    submittedAt?: number;
    completedAt?: number;
    requestId?: string;
    prompt?: string;
    actualSize?: string;
    actualFormat?: string;
    imagePath?: string;
    generationStatus?: ImageGenerationStatus;
    sendStatus?: ImageGenerationSendStatus;
    artifactUpdatedAt?: number;
}

export interface ImageGenerationArtifact {
    requestId: string;
    prompt: string;
    actualSize: string;
    actualFormat: string;
    imagePath: string;
    generationStatus: ImageGenerationStatus;
    sendStatus: ImageGenerationSendStatus;
    updatedAt: number;
}

export interface ReserveImageGenerationRequest {
    requestKey: string;
    groupOpenid: string;
    memberOpenid: string;
    messageId: string;
    dayKey: string;
    model: string;
    size: string;
    quality: string;
    outputFormat: string;
    requestedAt: number;
    dailyLimit: number;
    globalConcurrency: number;
}

export type ReserveImageGenerationResult =
    | { kind: "reserved" }
    | { kind: "duplicate" | "member_busy" | "global_busy" | "daily_limit" };

export interface ImageGenerationUsageQuery {
    groupOpenid?: string;
    memberOpenid?: string;
    since?: number;
    limit?: number;
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
    reserveImageGenerationRequest(request: ReserveImageGenerationRequest): Promise<ReserveImageGenerationResult>;
    markImageGenerationSubmitted(requestKey: string, at: number): Promise<boolean>;
    recordImageGenerationResult(requestKey: string, status: "generated" | "failed" | "unknown", usage: ImageGenerationUsage | undefined, at: number, artifact?: ImageGenerationArtifact): Promise<void>;
    finishImageGenerationRequest(requestKey: string, status: "succeeded" | "send_failed", at: number, sendStatus?: ImageGenerationSendStatus): Promise<void>;
    recoverPendingImageGenerationRequests(at: number): Promise<void>;
    listImageGenerationUsage(query?: ImageGenerationUsageQuery): Promise<ImageGenerationRequestRecord[]>;
}
