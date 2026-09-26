import { createHash } from "node:crypto";

export type ConversationKind = "group" | "private";

/** Converts an internal conversation key into a short, non-reversible UI identifier. */
export function toConversationIdentity(conversationKey: string): { conversationId: string; kind: ConversationKind; label: string } {
    const short = createHash("sha256").update(conversationKey).digest("hex").slice(0, 8).toUpperCase();
    const kind: ConversationKind = conversationKey.startsWith("group:") ? "group" : "private";
    return { conversationId: `c-${short}`, kind, label: `${kind === "group" ? "群" : "私聊"} ${short}` };
}
