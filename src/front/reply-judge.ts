import { TenBotError } from "../errors/tenbot-error.js";

export interface ReplyJudgeRequest {
    readonly conversation: readonly {
        readonly speaker: string;
        readonly content: string;
    }[];
    readonly currentMessage: {
        readonly speaker: string;
        readonly content: string;
    };
    readonly signals: {
        readonly nameMention: boolean;
        readonly conversationActive: boolean;
        readonly quotedBot: boolean;
    };
}

export interface ReplyJudgeDecision {
    readonly reply: boolean;
}

export interface ReplyJudge {
    judge(request: ReplyJudgeRequest): Promise<ReplyJudgeDecision>;
}

function topLevelKeys(payload: string): string[] {
    let index = 0;
    const skipWhitespace = () => {
        while (index < payload.length && /\s/.test(payload[index]!)) index++;
    };
    const skipString = (): string | undefined => {
        const start = index;
        if (payload[index] !== '"') return undefined;
        index++;
        while (index < payload.length) {
            if (payload[index] === "\\") {
                index += 2;
                continue;
            }
            if (payload[index++] === '"') {
                try {
                    return JSON.parse(payload.slice(start, index)) as string;
                } catch {
                    return undefined;
                }
            }
        }
        return undefined;
    };
    const skipValue = () => {
        if (payload[index] === '"') {
            skipString();
            return;
        }
        if (payload[index] === "{" || payload[index] === "[") {
            let depth = 0;
            let inString = false;
            for (; index < payload.length; index++) {
                const char = payload[index]!;
                if (inString) {
                    if (char === "\\") index++;
                    else if (char === '"') inString = false;
                } else if (char === '"') inString = true;
                else if (char === "{" || char === "[") depth++;
                else if (char === "}" || char === "]") {
                    depth--;
                    index++;
                    if (depth === 0) return;
                    index--;
                }
            }
            return;
        }
        while (index < payload.length && payload[index] !== "," && payload[index] !== "}") index++;
    };

    skipWhitespace();
    if (payload[index++] !== "{") return [];
    const keys: string[] = [];
    for (;;) {
        skipWhitespace();
        if (payload[index] === "}") return keys;
        const key = skipString();
        if (key === undefined) return [];
        keys.push(key);
        skipWhitespace();
        if (payload[index++] !== ":") return [];
        skipWhitespace();
        skipValue();
        skipWhitespace();
        if (payload[index] !== ",") return keys;
        index++;
    }
}

/** Parse the complete provider payload. No prose or partial-JSON recovery is permitted. */
export function parseReplyJudgeOutput(payload: string): ReplyJudgeDecision {
    let value: unknown;
    try {
        value = JSON.parse(payload);
    } catch {
        throw new TenBotError("F:A_RJ_IPO");
    }

    if (
        value === null ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Object.prototype
    ) {
        throw new TenBotError("F:A_RJ_IPO");
    }

    const keys = Object.keys(value);
    const decision = value as Record<string, unknown>;
    const sourceKeys = topLevelKeys(payload);
    if (
        keys.length !== 1 ||
        keys[0] !== "reply" ||
        sourceKeys.length !== 1 ||
        sourceKeys[0] !== "reply" ||
        typeof decision.reply !== "boolean"
    ) {
        throw new TenBotError("F:A_RJ_IPO");
    }

    return Object.freeze({ reply: decision.reply });
}
