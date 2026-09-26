import { createHash } from "node:crypto";
import type { KnownMember } from "../members/repository.js";

export interface KnownMemberSummary {
    /** Stable opaque key for UI reconciliation; never contains the QQ OpenID. */
    id: string;
    displayId: string;
    displayName: string;
    lastSeenAt: number;
    groupCount: number;
    roles?: string[];
}

/** Aggregate group-scoped SQLite rows into one safe display row per member. */
export function summarizeKnownMembers(members: readonly KnownMember[]): KnownMemberSummary[] {
    const grouped = new Map<string, { latest: KnownMember; lastSeenAt: number; groups: Set<string>; roles: Set<string> }>();
    for (const member of members) {
        const current = grouped.get(member.memberOpenid);
        if (!current) {
            grouped.set(member.memberOpenid, {
                latest: member,
                lastSeenAt: member.lastSeenAt,
                groups: new Set([member.groupOpenid]),
                roles: new Set(member.role ? [member.role] : []),
            });
            continue;
        }
        current.groups.add(member.groupOpenid);
        if (member.role) current.roles.add(member.role);
        current.lastSeenAt = Math.max(current.lastSeenAt, member.lastSeenAt);
        if (member.lastSeenAt > current.latest.lastSeenAt ||
            (member.lastSeenAt === current.latest.lastSeenAt && member.groupOpenid.localeCompare(current.latest.groupOpenid) < 0)) {
            current.latest = member;
        }
    }

    return [...grouped.entries()].map(([memberOpenid, aggregate]) => {
        const opaqueId = createHash("sha256").update(memberOpenid).digest("hex");
        const roles = [...aggregate.roles].sort();
        return {
            id: opaqueId,
            displayId: opaqueId.slice(0, 8).toUpperCase(),
            displayName: aggregate.latest.username,
            lastSeenAt: aggregate.lastSeenAt,
            groupCount: aggregate.groups.size,
            ...(roles.length ? { roles } : {}),
        };
    }).sort((a, b) => b.lastSeenAt - a.lastSeenAt || a.displayId.localeCompare(b.displayId));
}
