import { createHash } from "node:crypto";

export function toOpaqueMemberHash(memberOpenid: string): string {
    return createHash("sha256").update(memberOpenid).digest("hex");
}

export function toOpaqueMemberDisplayId(memberOpenid: string): string {
    return toOpaqueMemberHash(memberOpenid).slice(0, 8).toUpperCase();
}
