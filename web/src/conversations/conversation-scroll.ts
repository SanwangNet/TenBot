export const TIMELINE_BOTTOM_THRESHOLD = 40;

export interface ConversationTimelineViewport {
    scrollHeight: number;
    scrollTop: number;
    clientHeight: number;
}

export interface ProgrammaticScrollTarget {
    current: number | null;
}

export function syncTimelineToBottom(
    viewport: ConversationTimelineViewport | null,
    follow: boolean,
    programmaticScrollTarget: ProgrammaticScrollTarget,
): void {
    if (!follow || !viewport) return;
    const bottom = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    programmaticScrollTarget.current = bottom;
    viewport.scrollTop = bottom;
}

/** Returns null for a matching programmatic scroll event. */
export function followStateFromTimelineScroll(
    viewport: ConversationTimelineViewport,
    programmaticScrollTarget: ProgrammaticScrollTarget,
): boolean | null {
    const target = programmaticScrollTarget.current;
    programmaticScrollTarget.current = null;
    if (target !== null && Math.abs(viewport.scrollTop - target) <= 1) return null;
    return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < TIMELINE_BOTTOM_THRESHOLD;
}
