import { toOpaqueMemberDisplayId, toOpaqueMemberHash } from "../members/opaque-member-id.js";
import type { GroupSettings, GroupSettingsRepository } from "../members/repository.js";
import { logger, shortId } from "../shared/logger.js";

export interface GroupReplyStateRepository {
    getGroupRepliesEnabled(): Promise<boolean>;
    setGroupRepliesEnabled(enabled: boolean): Promise<void>;
}

export interface GroupReplyChangeResult {
    ok: boolean;
    changed: boolean;
    notFound?: boolean;
}

type PendingWorkCanceller = (groupOpenid?: string) => void;

/** Runtime-owned global and group gates backed by SQLite. */
export class GroupReplyControl {
    private enabled = false;
    private readonly groupSettings = new Map<string, boolean>();
    private readonly pendingWorkCancellers = new Set<PendingWorkCanceller>();
    private updateQueue: Promise<void> = Promise.resolve();

    constructor(
        private readonly repository: GroupReplyStateRepository,
        private readonly groupRepository: GroupSettingsRepository,
        private readonly onChanged: (enabled: boolean) => void = () => undefined,
        private readonly onGroupChanged: (groupOpenid: string, enabled: boolean) => void = () => undefined,
    ) {}

    async initialize(): Promise<boolean> {
        try {
            this.enabled = await this.repository.getGroupRepliesEnabled();
        } catch (error) {
            this.enabled = false;
            logger.error("[Runtime] failed to load group reply state; replies remain disabled", error);
        }
        try {
            this.groupSettings.clear();
            for (const group of await this.groupRepository.listGroups()) {
                this.groupSettings.set(group.groupOpenid, group.repliesEnabled);
            }
        } catch (error) {
            this.groupSettings.clear();
            logger.error("[Runtime] failed to load group settings; group replies remain disabled until verified", error);
        }
        return this.enabled;
    }

    getGroupRepliesEnabled(): boolean {
        return this.enabled;
    }

    getGroupRepliesEnabledForGroup(groupOpenid: string): boolean {
        return this.getGroupSettingEnabled(groupOpenid) && this.enabled;
    }

    getGroupSettingEnabled(groupOpenid: string): boolean {
        return this.groupSettings.get(groupOpenid) === true;
    }

    registerPendingWorkCanceller(cancel: PendingWorkCanceller): () => void {
        this.pendingWorkCancellers.add(cancel);
        return () => this.pendingWorkCancellers.delete(cancel);
    }

    async observeGroup(groupOpenid: string, displayName?: string, at = Date.now()): Promise<boolean> {
        try {
            const group = await this.groupRepository.ensureGroup(groupOpenid, at, displayName);
            this.groupSettings.set(groupOpenid, group.repliesEnabled);
            return this.getGroupRepliesEnabledForGroup(groupOpenid);
        } catch (error) {
            this.groupSettings.set(groupOpenid, false);
            logger.error("[Runtime] failed to persist group settings; replies remain disabled for group", error);
            return false;
        }
    }

    async getGroupSettings(groupOpenid: string): Promise<GroupSettings | null> {
        const group = await this.groupRepository.getGroupSettings(groupOpenid);
        if (group) this.groupSettings.set(groupOpenid, group.repliesEnabled);
        return group;
    }

    listGroups(): Promise<GroupSettings[]> {
        return this.groupRepository.listGroups();
    }

    async setGroupRepliesEnabled(enabled: boolean, adminDisplayId: string): Promise<GroupReplyChangeResult> {
        let result: GroupReplyChangeResult = { ok: false, changed: false };
        const operation = this.updateQueue.then(async () => {
            if (this.enabled === enabled) {
                logger.info(`[Runtime] group replies ${enabled ? "enabled" : "disabled"} admin=${adminDisplayId}`);
                result = { ok: true, changed: false };
                return;
            }
            try {
                await this.repository.setGroupRepliesEnabled(enabled);
            } catch (error) {
                logger.error("[Runtime] failed to persist group reply state", error);
                result = { ok: false, changed: false };
                return;
            }

            // Publish the new gate only after SQLite has accepted the write.
            this.enabled = enabled;
            if (!enabled) {
                for (const cancel of this.pendingWorkCancellers) {
                    try { cancel(); }
                    catch (error) { logger.error("[Runtime] failed to cancel pending group admission", error); }
                }
            }
            try { this.onChanged(enabled); }
            catch (error) { logger.error("[Runtime] failed to publish group reply state", error); }
            logger.info(`[Runtime] group replies ${enabled ? "enabled" : "disabled"} admin=${adminDisplayId}`);
            result = { ok: true, changed: true };
        });
        this.updateQueue = operation.then(() => undefined, () => undefined);
        await operation;
        return result;
    }

    async setGroupRepliesEnabledForGroup(
        groupOpenid: string,
        enabled: boolean,
        adminDisplayId: string,
    ): Promise<GroupReplyChangeResult> {
        let result: GroupReplyChangeResult = { ok: false, changed: false };
        const operation = this.updateQueue.then(async () => {
            try {
                const current = await this.groupRepository.getGroupSettings(groupOpenid);
                if (!current) {
                    result = { ok: false, changed: false, notFound: true };
                    return;
                }
                if (current.repliesEnabled === enabled) {
                    this.groupSettings.set(groupOpenid, enabled);
                    result = { ok: true, changed: false };
                    return;
                }
                const updated = await this.groupRepository.setGroupRepliesEnabledForGroup(groupOpenid, enabled, Date.now());
                if (!updated) {
                    result = { ok: false, changed: false, notFound: true };
                    return;
                }
                this.groupSettings.set(groupOpenid, enabled);
                if (!enabled) {
                    for (const cancel of this.pendingWorkCancellers) {
                        try { cancel(groupOpenid); }
                        catch (error) { logger.error("[Runtime] failed to cancel group-specific admission", error); }
                    }
                }
                try { this.onGroupChanged(groupOpenid, enabled); }
                catch (error) { logger.error("[Runtime] failed to publish group reply state", error); }
                logger.info(`[Runtime] group replies ${enabled ? "enabled" : "disabled"} group=${shortId(groupOpenid)} admin=${adminDisplayId}`);
                result = { ok: true, changed: true };
            } catch (error) {
                logger.error("[Runtime] failed to persist group reply state", error);
                result = { ok: false, changed: false };
            }
        });
        this.updateQueue = operation.then(() => undefined, () => undefined);
        await operation;
        return result;
    }
}

export function isConfiguredBotAdmin(memberOpenid: string | undefined, configuredIds: readonly string[]): boolean {
    if (!memberOpenid) return false;
    const displayId = toOpaqueMemberDisplayId(memberOpenid);
    const fullHash = toOpaqueMemberHash(memberOpenid);
    return configuredIds.some((configured) => {
        const normalized = configured.trim().toUpperCase();
        return normalized === displayId || normalized === fullHash.toUpperCase();
    });
}
