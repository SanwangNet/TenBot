import { createHash } from "node:crypto";

/** Converts an internal conversation key into a short, non-reversible UI identifier. */
export function toConversationIdentity(conversationKey: string): { conversationId: string; label: string } {
    const short = createHash("sha256").update(conversationKey).digest("hex").slice(0, 8).toUpperCase();
    return { conversationId: `c-${short}`, label: `群 ${short}` };
}
