import type { TenBotErrorCode } from "./catalog.js";

export type RemoteErrorStage = "MP" | "QQ";

const REMOTE_HTTP_ERROR_CODES: Readonly<Record<RemoteErrorStage, Readonly<Record<number, TenBotErrorCode>>>> = {
    MP: {
        500: "R:A_MP_PIE",
        502: "R:A_MP_PBG",
        503: "R:A_MP_PSU",
        504: "R:A_MP_PGT",
    },
    QQ: {
        500: "R:A_QQ_QIE",
        502: "R:A_QQ_QBG",
        503: "R:A_QQ_QSU",
        504: "R:A_QQ_QGT",
    },
};

/** Finds only an explicit HTTP response status; socket error names are not remote statuses. */
export function findExplicitHttpStatus(error: unknown): number | undefined {
    const seen = new Set<object>();
    const queue: unknown[] = [error];
    while (queue.length && seen.size < 8) {
        const value = queue.shift();
        if (!value || typeof value !== "object" || seen.has(value)) continue;
        seen.add(value);
        const fields = value as Record<string, unknown>;
        if (typeof fields.status === "number" && Number.isInteger(fields.status) && fields.status >= 100 && fields.status <= 599) {
            return fields.status;
        }
        for (const key of ["cause", "error", "body", "response"] as const) {
            if (fields[key] !== undefined) queue.push(fields[key]);
        }
    }
    return undefined;
}

export function mapConfirmedRemoteHttpError(
    stage: RemoteErrorStage,
    status: number | undefined,
): TenBotErrorCode | undefined {
    return status === undefined ? undefined : REMOTE_HTTP_ERROR_CODES[stage][status];
}
