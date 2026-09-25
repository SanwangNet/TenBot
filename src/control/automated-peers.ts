export interface AutomatedPeerSummary {
    id: string;
    displayId: string;
    displayName: string;
    platformBotHint: boolean;
    lastSeenAt?: string;
}

export interface AutomatedPeerMutationResult {
    ok: boolean;
    changed: boolean;
    message: string;
    details?: string;
}
