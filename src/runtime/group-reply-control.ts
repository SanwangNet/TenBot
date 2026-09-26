import { toOpaqueMemberDisplayId, toOpaqueMemberHash } from "../members/opaque-member-id.js";
import { logger } from "../shared/logger.js";

export interface GroupReplyStateRepository {
    getGroupRepliesEnabled(): Promise<boolean>;
    setGroupRepliesEnabled(enabled: boolean): Promise<void>;
}

export interface GroupReplyChangeResult {
    ok: boolean;
    changed: boolean;
}

/** Runtime-owned in-memory gate backed by the Runtime state repository. */
export class GroupReplyControl {
    private enabled = false;
    private readonly pendingWorkCancellers = new Set<() => void>();
    private updateQueue: Promise<void> = Promise.resolve();

    constructor(
        private readonly repository: GroupReplyStateRepository,
        private readonly onChanged: (enabled: boolean) => void = () => undefined,
    ) {}

    async initialize(): Promise<boolean> {
        try {
            this.enabled = await this.repository.getGroupRepliesEnabled();
        } catch (error) {
            this.enabled = false;
            logger.error("[Runtime] failed to load group reply state; replies remain disabled", error);
        }
        return this.enabled;
    }

    getGroupRepliesEnabled(): boolean {
        return this.enabled;
    }

    registerPendingWorkCanceller(cancel: () => void): () => void {
        this.pendingWorkCancellers.add(cancel);
        return () => this.pendingWorkCancellers.delete(cancel);
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
