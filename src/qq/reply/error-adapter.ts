import { findExplicitHttpStatus, mapConfirmedRemoteHttpError } from "../../errors/http-mapping.js";
import { TenBotError } from "../../errors/tenbot-error.js";

/** A failed QQ send is never retried; this only names the failure for diagnostics. */
export function createQqSendError(error: unknown, sent: number): TenBotError {
    const status = findExplicitHttpStatus(error);
    const code = mapConfirmedRemoteHttpError("QQ", status) ?? (sent > 0 ? "B:B_QT_PSF" : "B:A_QT_QSF");
    return new TenBotError(code, {
        cause: error,
        safeDetails: { sent, ...(status === undefined ? {} : { httpStatus: status }) },
    });
}
