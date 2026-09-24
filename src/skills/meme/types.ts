export interface MemeSource {
    name: string;
    url: string;
}

export interface MemeCandidate {
    name: string;
    aliases: string[];
    summary: string;
    origin: string;
    meaning: string;
    usage: string;
    examples: string[];
    sources: MemeSource[];
}

export interface MemeEntry extends MemeCandidate {
    id: string;
    firstSeenAt: string;
    updatedAt: string;
}
