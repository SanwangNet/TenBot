import type {
    GroupMember, GroupSettings, ImageGenerationArtifact, ImageGenerationRequestRecord, ImageGenerationRequestStatus, ImageGenerationSendStatus, ImageGenerationUsage,
    ImageGenerationUsageQuery, KnownMember, MemberBotState, MemberRepository, ReserveImageGenerationRequest,
    ReserveImageGenerationResult,
} from "./repository.js";
import {
    MEMBER_BOT_DETECTION_EVIDENCE_TTL_MS,
    type AddMemberBotDetectionEvidence,
    type MemberBotDetectionEvidence,
    type MemberBotDetectionObservation,
} from "./detection-evidence.js";

/** Ephemeral fallback and test adapter; production Node configures SQLite at startup. */
export class MemoryMemberRepository implements MemberRepository {
    private readonly members = new Map<string, Map<string, KnownMember>>();
    private readonly groups = new Map<string, GroupSettings>();
    private readonly botStates = new Map<string, MemberBotState>();
    private readonly detectionEvidence = new Map<string, MemberBotDetectionEvidence[]>();
    private readonly detectionObservations = new Map<string, Map<string, MemberBotDetectionObservation>>();
    private readonly imageGenerationRequests = new Map<string, ImageGenerationRequestRecord>();
    private nextDetectionEvidenceId = 1;
    private legacyImportCompleted = false;

    constructor(private readonly now: () => number = Date.now) {}

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

    async reserveImageGenerationRequest(request: ReserveImageGenerationRequest): Promise<ReserveImageGenerationResult> {
        if (this.imageGenerationRequests.has(request.requestKey)) return { kind: "duplicate" };
        const rows = [...this.imageGenerationRequests.values()];
        if (rows.some((row) => row.groupOpenid === request.groupOpenid && row.memberOpenid === request.memberOpenid &&
            ["reserved", "submitted", "generated"].includes(row.status))) return { kind: "member_busy" };
        if (rows.filter((row) => row.status === "reserved" || row.status === "submitted").length >= request.globalConcurrency) {
            return { kind: "global_busy" };
        }
        const chargedToday = rows.filter((row) => row.groupOpenid === request.groupOpenid && row.memberOpenid === request.memberOpenid &&
            row.dayKey === request.dayKey && row.submittedAt !== undefined).length;
        if (chargedToday >= request.dailyLimit) return { kind: "daily_limit" };
        this.imageGenerationRequests.set(request.requestKey, {
            requestKey: request.requestKey, groupOpenid: request.groupOpenid, memberOpenid: request.memberOpenid,
            messageId: request.messageId, dayKey: request.dayKey, status: "reserved", model: request.model,
            size: request.size, quality: request.quality, outputFormat: request.outputFormat, requestedAt: request.requestedAt,
        });
        return { kind: "reserved" };
    }

    async markImageGenerationSubmitted(requestKey: string, at: number): Promise<boolean> {
        const row = this.imageGenerationRequests.get(requestKey);
        if (!row || row.status !== "reserved") return false;
        row.status = "submitted";
        row.submittedAt = at;
        return true;
    }

    async recordImageGenerationResult(requestKey: string, status: "generated" | "failed" | "unknown", usage: ImageGenerationUsage | undefined, at: number, artifact?: ImageGenerationArtifact): Promise<void> {
        const row = this.imageGenerationRequests.get(requestKey);
        if (!row || (row.status !== "reserved" && row.status !== "submitted")) return;
        row.status = status;
        row.completedAt = at;
        if (usage) Object.assign(row, usage);
        if (artifact) {
            row.requestId = artifact.requestId;
            row.prompt = artifact.prompt;
            row.actualSize = artifact.actualSize;
            row.actualFormat = artifact.actualFormat;
            row.imagePath = artifact.imagePath;
            row.generationStatus = artifact.generationStatus;
            row.sendStatus = artifact.sendStatus;
            row.artifactUpdatedAt = artifact.updatedAt;
        }
    }

    async finishImageGenerationRequest(requestKey: string, status: "succeeded" | "send_failed", at: number, sendStatus?: ImageGenerationSendStatus): Promise<void> {
        const row = this.imageGenerationRequests.get(requestKey);
        if (!row || row.status !== "generated") return;
        row.status = status;
        row.completedAt = at;
        if (sendStatus) {
            row.sendStatus = sendStatus;
            row.artifactUpdatedAt = at;
        }
    }

    async recoverPendingImageGenerationRequests(at: number): Promise<void> {
        for (const row of this.imageGenerationRequests.values()) {
            if (row.status === "reserved") row.status = "failed";
            else if (row.status === "submitted") row.status = "unknown";
            else if (row.status === "generated") {
                row.status = "send_failed";
                if (row.sendStatus === "pending") row.sendStatus = "unknown";
            }
            else continue;
            row.completedAt = at;
        }
    }

    async listImageGenerationUsage(query: ImageGenerationUsageQuery = {}): Promise<ImageGenerationRequestRecord[]> {
        return [...this.imageGenerationRequests.values()]
            .filter((row) => (!query.groupOpenid || row.groupOpenid === query.groupOpenid) &&
                (!query.memberOpenid || row.memberOpenid === query.memberOpenid) &&
                (query.since === undefined || row.requestedAt >= query.since))
            .sort((a, b) => b.requestedAt - a.requestedAt)
            .slice(0, Math.max(1, Math.min(500, Math.trunc(query.limit ?? 100))))
            .map((row) => ({ ...row }));
    }

    async getMemberBotState(groupOpenid: string, memberOpenid: string): Promise<MemberBotState> {
        const state = this.botStates.get(botStateKey(groupOpenid, memberOpenid)) ?? defaultBotState(groupOpenid, memberOpenid);
        const events = await this.listActiveDetectionEvidence(groupOpenid, memberOpenid);
        return {
            ...state,
            autoBot: false,
            detectionMarks: events.length,
            lastDetectionAt: events.reduce<number | null>((latest, event) =>
                latest === null || event.createdAt > latest ? event.createdAt : latest, null),
        };
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

    async addDetectionEvidence(evidence: AddMemberBotDetectionEvidence): Promise<MemberBotDetectionEvidence> {
        const createdAt = evidence.createdAt ?? this.now();
        const event: MemberBotDetectionEvidence = {
            id: this.nextDetectionEvidenceId++,
            groupOpenid: evidence.groupOpenid,
            memberOpenid: evidence.memberOpenid,
            signalType: evidence.signalType,
            createdAt,
            expiresAt: evidence.expiresAt ?? createdAt + MEMBER_BOT_DETECTION_EVIDENCE_TTL_MS,
        };
        const key = botStateKey(event.groupOpenid, event.memberOpenid);
        const events = this.detectionEvidence.get(key) ?? [];
        events.push(event);
        this.detectionEvidence.set(key, events);
        return { ...event };
    }

    async addDetectionEvidenceIfCooldownElapsed(
        evidence: AddMemberBotDetectionEvidence,
        cooldownMs: number,
    ): Promise<MemberBotDetectionEvidence | null> {
        const createdAt = evidence.createdAt ?? this.now();
        const events = this.detectionEvidence.get(botStateKey(evidence.groupOpenid, evidence.memberOpenid)) ?? [];
        if (events.some((event) => event.signalType === evidence.signalType && event.createdAt > createdAt - cooldownMs)) return null;
        return this.addDetectionEvidence({ ...evidence, createdAt });
    }

    async listActiveDetectionEvidence(groupOpenid: string, memberOpenid: string, at = this.now()): Promise<MemberBotDetectionEvidence[]> {
        return (this.detectionEvidence.get(botStateKey(groupOpenid, memberOpenid)) ?? [])
            .filter((event) => event.expiresAt > at)
            .map((event) => ({ ...event }));
    }

    async getActiveDetectionCount(groupOpenid: string, memberOpenid: string, at = this.now()): Promise<number> {
        return (this.detectionEvidence.get(botStateKey(groupOpenid, memberOpenid)) ?? [])
            .filter((event) => event.expiresAt > at).length;
    }

    async clearDetectionEvidence(groupOpenid: string, memberOpenid: string): Promise<MemberBotState> {
        this.detectionEvidence.delete(botStateKey(groupOpenid, memberOpenid));
        this.detectionObservations.delete(botStateKey(groupOpenid, memberOpenid));
        return this.getMemberBotState(groupOpenid, memberOpenid);
    }

    async recordDetectionObservation(observation: MemberBotDetectionObservation): Promise<boolean> {
        const key = botStateKey(observation.groupOpenid, observation.memberOpenid);
        let messages = this.detectionObservations.get(key);
        if (!messages) {
            messages = new Map();
            this.detectionObservations.set(key, messages);
        }
        if (messages.has(observation.messageId)) return false;
        messages.set(observation.messageId, { ...observation });
        return true;
    }

    async listRecentDetectionObservations(
        groupOpenid: string,
        memberOpenid: string,
        since: number,
        through: number,
        at = this.now(),
    ): Promise<MemberBotDetectionObservation[]> {
        return [...(this.detectionObservations.get(botStateKey(groupOpenid, memberOpenid))?.values() ?? [])]
            .filter((observation) => observation.observedAt >= since && observation.observedAt <= through && observation.expiresAt > at)
            .sort((left, right) => left.observedAt - right.observedAt || left.messageId.localeCompare(right.messageId))
            .map((observation) => ({ ...observation }));
    }

    async pruneExpiredDetectionEvidence(at = this.now()): Promise<void> {
        for (const [key, events] of this.detectionEvidence) {
            const active = events.filter((event) => event.expiresAt > at);
            if (active.length) this.detectionEvidence.set(key, active);
            else this.detectionEvidence.delete(key);
        }
        for (const [key, messages] of this.detectionObservations) {
            for (const [messageId, observation] of messages) {
                if (observation.expiresAt <= at) messages.delete(messageId);
            }
            if (!messages.size) this.detectionObservations.delete(key);
        }
    }

    async listMarkedBots(): Promise<GroupMember[]> {
        const output: GroupMember[] = [];
        for (const member of await this.listAll()) {
            const state = await this.getMemberBotState(member.groupOpenid, member.memberOpenid);
            if (state.platformBot || state.manualBot) output.push({ ...member, ...state });
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
        return member ? { ...member, ...await this.getMemberBotState(groupOpenid, memberOpenid),
            activeDetectionEvidence: await this.listActiveDetectionEvidence(groupOpenid, memberOpenid) } : null;
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
