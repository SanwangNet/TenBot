import type { NormalizedQqMessage } from "../message/normalize-message.js";

export interface RecentPeer {
    id: string;
    displayName?: string;
    platformBotHint: boolean;
    lastSeenAt: string;
}

function safeDisplayName(value: string | undefined): string | undefined {
    const name = value?.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
    return name || undefined;
}

/** A bounded in-memory directory for local account management; it stores no message content. */
export class RecentPeerRegistry {
    private readonly peers = new Map<string, RecentPeer>();

    constructor(
        private readonly capacity = 100,
        private readonly now: () => Date = () => new Date(),
    ) {
        if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error("Recent peer capacity must be positive");
    }

    observe(message: NormalizedQqMessage): RecentPeer | undefined {
        if (message.kind !== "group" || !message.authorId || message.author?.is_you === true || message.author?.isYou === true) {
            return undefined;
        }
        const id = message.authorId.trim();
        if (!id || id.length > 256 || /[,\u0000-\u001f\u007f-\u009f]/.test(id)) return undefined;

        const existing = this.peers.get(id);
        const displayName = safeDisplayName(message.authorName);
        const peer: RecentPeer = {
            id,
            displayName: displayName || existing?.displayName,
            platformBotHint: message.authorIsBot,
            lastSeenAt: this.now().toISOString(),
        };
        this.peers.delete(id);
        this.peers.set(id, peer);
        while (this.peers.size > this.capacity) {
            const oldest = this.peers.keys().next().value as string | undefined;
            if (oldest === undefined) break;
            this.peers.delete(oldest);
        }
        return { ...peer };
    }

    get(id: string): RecentPeer | undefined {
        const peer = this.peers.get(id);
        return peer ? { ...peer } : undefined;
    }

    list(): RecentPeer[] {
        return [...this.peers.values()].reverse().map((peer) => ({ ...peer }));
    }
}
