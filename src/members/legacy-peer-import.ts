import type { MemberRepository } from "./repository.js";
import { toOpaqueMemberDisplayId, toOpaqueMemberHash } from "./opaque-member-id.js";
import { logger } from "../shared/logger.js";

export interface LegacyPeerImportResult {
    imported: number;
    unmatched: number;
    skipped: boolean;
}

export function parseLegacyAutomatedPeerIds(value: string | undefined): string[] {
    return [...new Set((value ?? "").split(",").map((id) => id.trim()).filter(Boolean))];
}

/** Imports only IDs that can be resolved to persisted group membership; it never guesses a group. */
export async function importLegacyAutomatedPeerIds(
    repository: MemberRepository,
    legacyIds: readonly string[],
    now: () => number = Date.now,
): Promise<LegacyPeerImportResult> {
    if (!legacyIds.length) return { imported: 0, unmatched: 0, skipped: true };
    if (await repository.wasLegacyAutomatedPeerImportCompleted()) return { imported: 0, unmatched: 0, skipped: true };

    const members = await repository.listAll();
    const importedPairs = new Set<string>();
    let unmatched = 0;
    for (const legacyId of new Set(legacyIds.map((id) => id.trim()).filter(Boolean))) {
        const normalized = legacyId.toLowerCase();
        const matches = members.filter((member) => member.memberOpenid === legacyId ||
            toOpaqueMemberDisplayId(member.memberOpenid).toLowerCase() === normalized ||
            toOpaqueMemberHash(member.memberOpenid).toLowerCase() === normalized);
        if (!matches.length) {
            unmatched++;
            continue;
        }
        for (const member of matches) {
            const key = `${member.groupOpenid}\u0000${member.memberOpenid}`;
            if (importedPairs.has(key)) continue;
            importedPairs.add(key);
            await repository.setManualBot(member.groupOpenid, member.memberOpenid, true, now());
        }
    }
    await repository.markLegacyAutomatedPeerImportCompleted(now());
    if (importedPairs.size || unmatched) {
        logger.warn(`[Members] imported ${importedPairs.size} legacy AUTOMATED_PEER_IDS into group-scoped Bot state; unmatched IDs=${unmatched}`);
    }
    return { imported: importedPairs.size, unmatched, skipped: false };
}
