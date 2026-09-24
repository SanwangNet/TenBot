/** Small, SDK-independent shape used while normalizing AI output. */
export interface UrlCitation {
    title?: string;
    url: string;
    startIndex: number;
    endIndex: number;
}

export interface CitedText {
    text: string;
    citations: readonly UrlCitation[];
}

export interface CitationRenderResult {
    content: string;
    renderedCount: number;
    metadataUnavailable: boolean;
}

const INTERNAL_MARKER = /cite[^]*/g;
const BARE_MARKER = /\bturn\d+search\d+\b/g;
const SOURCE_NAMES: readonly [string, string][] = [
    ["developer.mozilla.org", "MDN"],
    ["wikipedia.org", "Wikipedia"],
    ["openai.com", "OpenAI"],
    ["github.com", "GitHub"],
    ["reuters.com", "Reuters"],
    ["apnews.com", "AP"],
    ["bbc.com", "BBC"],
    ["bbc.co.uk", "BBC"],
];

/** Accepts the SDK's url_citation shape without exporting its union to QQ code. */
export function normalizeUrlCitation(annotation: unknown): UrlCitation | null {
    if (!annotation || typeof annotation !== "object") return null;
    const data = annotation as Record<string, unknown>;
    if (data.type !== "url_citation" || typeof data.url !== "string" ||
        !Number.isSafeInteger(data.start_index) || !Number.isSafeInteger(data.end_index)) {
        return null;
    }
    return {
        title: typeof data.title === "string" ? data.title : undefined,
        url: data.url,
        startIndex: data.start_index as number,
        endIndex: data.end_index as number,
    };
}

function safeUrl(raw: string): URL | null {
    if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
    try {
        const url = new URL(raw);
        return (url.protocol === "http:" || url.protocol === "https:") && url.hostname
            ? url : null;
    } catch {
        return null;
    }
}

export function formatSourceName(url: string, title?: string): string {
    const parsed = safeUrl(url);
    if (!parsed) return "来源";
    const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
    for (const [domain, name] of SOURCE_NAMES) {
        if (hostname === domain || hostname.endsWith("." + domain)) return name;
    }

    const cleanTitle = title?.replace(/\s+/g, " ").trim() ?? "";
    const suffix = cleanTitle.split(/\s[-–—|]\s/).at(-1) ?? "";
    const candidate = suffix.length < cleanTitle.length ? suffix : cleanTitle;
    if (candidate && candidate.length <= 36 && candidate.split(/\s+/).length <= 5 &&
        !/^https?:\/\//i.test(candidate)) {
        return candidate;
    }
    return hostname || "来源";
}

function markdownLabel(name: string): string {
    return name.replace(/[\\[\]()]/g, "\\$&");
}

function markdownDestination(url: URL): string {
    const href = url.href;
    let depth = 0;
    for (const char of href) {
        if (char === "(") depth++;
        if (char === ")" && --depth < 0) return `<${href}>`;
    }
    return depth === 0 ? href : `<${href}>`;
}

function linkFor(citation: UrlCitation): string | null {
    const url = safeUrl(citation.url);
    if (!url) return null;
    return `[${markdownLabel(formatSourceName(citation.url, citation.title))}](${markdownDestination(url)})`;
}

interface Placement {
    start: number;
    end: number;
    marker?: string;
}

function markerWithin(text: string, start: number, end: number): Placement | null {
    const span = text.slice(start, end);
    const fullMarkers = [...span.matchAll(INTERNAL_MARKER)];
    const matches = fullMarkers.length ? fullMarkers : [...span.matchAll(BARE_MARKER)].filter((bare) =>
        ![...text.matchAll(INTERNAL_MARKER)].some((full) =>
            start + bare.index >= full.index &&
            start + bare.index + bare[0].length <= full.index + full[0].length));
    if (matches.length === 1) {
        const match = matches[0]!;
        return { start: start + match.index, end: start + match.index + match[0].length, marker: match[0] };
    }
    const adjacent = text.slice(end).match(/^cite[^]*/);
    if (adjacent) return { start: end, end: end + adjacent[0].length, marker: adjacent[0] };
    const bareAdjacent = text.slice(end).match(/^turn\d+search\d+\b/);
    if (bareAdjacent) {
        return { start: end, end: end + bareAdjacent[0].length, marker: bareAdjacent[0] };
    }
    return null;
}

function placementFor(text: string, citation: UrlCitation): Placement | null {
    const { startIndex, endIndex } = citation;
    if (!Number.isSafeInteger(startIndex) || !Number.isSafeInteger(endIndex) ||
        startIndex < 0 || endIndex <= startIndex) return null;

    // SDK indices normally address the JS string. Accept code-point offsets too when
    // they clearly identify the citation marker after an astral character.
    if (endIndex <= text.length) {
        const direct = markerWithin(text, startIndex, endIndex);
        if (direct) return direct;
    }
    const chars = Array.from(text);
    if (endIndex <= chars.length) {
        const start = chars.slice(0, startIndex).join("").length;
        const end = chars.slice(0, endIndex).join("").length;
        const byCodePoint = markerWithin(text, start, end);
        if (byCodePoint) return byCodePoint;
    }
    if (endIndex <= text.length) {
        // Do not insert into a malformed or differently indexed marker.
        if ([...text.matchAll(INTERNAL_MARKER)].some((marker) =>
            marker.index < endIndex && endIndex < marker.index + marker[0].length)) {
            return null;
        }
        return { start: endIndex, end: endIndex };
    }
    return null;
}

/** Transfers a source only when an annotated span identifies the same literal marker. */
export function collectMarkerSources(parts: readonly CitedText[]): Map<string, UrlCitation> {
    const sources = new Map<string, UrlCitation>();
    const ambiguous = new Set<string>();
    for (const part of parts) {
        for (const citation of part.citations) {
            const marker = placementFor(part.text, citation)?.marker;
            if (!marker || !safeUrl(citation.url) || ambiguous.has(marker)) continue;
            const existing = sources.get(marker);
            if (existing && existing.url !== citation.url) {
                sources.delete(marker);
                ambiguous.add(marker);
            } else {
                sources.set(marker, citation);
            }
        }
    }
    return sources;
}

/** Replaces indexed citations from right to left, then strips any unresolvable internal markers. */
export function renderCitations(
    text: string,
    citations: readonly UrlCitation[],
    markerSources: ReadonlyMap<string, UrlCitation> = new Map(),
): CitationRenderResult {
    const spans = new Map<string, { placement: Placement; links: Map<string, string> }>();
    for (const citation of citations) {
        const placement = placementFor(text, citation);
        const link = linkFor(citation);
        if (!placement || !link) continue;
        const key = `${placement.start}:${placement.end}`;
        let group = spans.get(key);
        if (!group) {
            group = { placement, links: new Map() };
            spans.set(key, group);
        }
        group.links.set(citation.url, link);
    }

    const indexed = [...spans.values()].map(({ placement, links }) => ({
        start: placement.start,
        end: placement.end,
        replacement: `（${[...links.values()].join("、")}）`,
        count: links.size,
        unavailable: false,
    }));
    const fullMarkers = [...text.matchAll(INTERNAL_MARKER)];
    const bareMarkers = [...text.matchAll(BARE_MARKER)].filter((bare) =>
        !fullMarkers.some((full) => bare.index >= full.index &&
            bare.index + bare[0].length <= full.index + full[0].length));
    const markerReplacements = [...fullMarkers, ...bareMarkers]
        .filter((match) => !indexed.some((span) =>
            span.start <= match.index && span.end >= match.index + match[0].length))
        .map((match) => {
            const citation = markerSources.get(match[0]);
            const link = citation && linkFor(citation);
            return {
                start: match.index,
                end: match.index + match[0].length,
                replacement: link ? `（${link}）` : "",
                count: link ? 1 : 0,
                unavailable: !link,
            };
        });

    let content = text;
    let renderedCount = 0;
    let metadataUnavailable = false;
    let previousStart = text.length + 1;
    for (const operation of [...indexed, ...markerReplacements]
        .sort((a, b) => b.start - a.start || b.end - a.end)) {
        if (operation.end > previousStart) continue;
        content = content.slice(0, operation.start) + operation.replacement + content.slice(operation.end);
        renderedCount += operation.count;
        metadataUnavailable ||= operation.unavailable;
        previousStart = operation.start;
    }
    return { content, renderedCount, metadataUnavailable };
}
