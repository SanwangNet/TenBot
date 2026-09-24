export interface MemeInteraction {
    input: string;
    responses: string[];
}

export interface MemeCandidate {
    name: string;
    aliases: string[];
    summary: string;
    origin: string;
    meaning: string;
    usage: string;
    examples: string[];
    interactions?: MemeInteraction[];
}

export interface MemeEntry extends MemeCandidate {
    id: string;
}
