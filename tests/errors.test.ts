import assert from "node:assert/strict";
import { test } from "node:test";

import { ERROR_CATALOG, ERROR_STAGE_CATALOG, isTenBotErrorCode } from "../src/errors/catalog.js";
import { formatTenBotError, parseErrorCode, toPublicErrorMessage } from "../src/errors/format.js";
import { findExplicitHttpStatus, mapConfirmedRemoteHttpError } from "../src/errors/http-mapping.js";
import { TenBotError } from "../src/errors/tenbot-error.js";
import { createProviderErrorNotice } from "../src/control/provider-error.js";
import { createQqSendError } from "../src/qq/reply/error-adapter.js";
import { getLogLevel, logger, setLogLevel } from "../src/shared/logger.js";

test("the catalog is the single valid source for code grammar and stage IDs", () => {
    const codes = Object.keys(ERROR_CATALOG);
    assert.equal(new Set(codes).size, codes.length);
    for (const code of codes) {
        assert.match(code, /^[FMBR]:[ABC]_[A-Z0-9]{2,4}_[A-Z0-9]{2,8}$/);
        assert.ok(isTenBotErrorCode(code));
        const parsed = parseErrorCode(code);
        assert.ok(parsed);
        assert.ok(Object.hasOwn(ERROR_STAGE_CATALOG[parsed.zone], parsed.stage));
        const metadata = ERROR_CATALOG[code as keyof typeof ERROR_CATALOG];
        assert.ok(metadata.english.trim());
        assert.ok(metadata.chinese.trim());
    }
});

test("error-code parsing rejects syntactically valid codes outside the catalog", () => {
    assert.deepEqual(parseErrorCode("B:A_OP_TPL"), { zone: "B", class: "A", stage: "OP", reason: "TPL" });
    assert.equal(parseErrorCode("B:A_OP_UNKNOWN"), null);
    assert.equal(parseErrorCode("ABC:XYZ"), null);
});

test("TenBotError uses its English name, fixed bilingual log line, and public error prefix", () => {
    const error = new TenBotError("F:A_RJ_IPI", { cause: new Error("provider raw body must stay private") });
    assert.equal(error.message, "Invalid Protocol Input");
    assert.equal(formatTenBotError(error), "[ERROR] F:A_RJ_IPI Invalid Protocol Input / 非法的协议输入");
    assert.equal(toPublicErrorMessage(error), "ERROR: F:A_RJ_IPI");
    assert.equal(toPublicErrorMessage(new TenBotError("R:A_MP_PSU")), "ERROR: R:A_MP_PSU");
    assert.doesNotMatch(formatTenBotError(error), /provider raw body/);
    assert.throws(() => new TenBotError("ABC:XYZ" as never), /Unknown TenBot error code/);
});

test("safe diagnostic context is allowlisted and appended after the standard error line", () => {
    const error = new TenBotError("B:A_OP_TPL", {
        safeDetails: { provider: "gpt", attempt: 2, httpStatus: 503, stageOrder: 7 },
    });
    assert.equal(
        formatTenBotError(error),
        "[ERROR] B:A_OP_TPL Tool Protocol Leakage / 工具协议泄漏 provider=gpt attempt=2 httpStatus=503 stageOrder=7",
    );
    const unsafe = new TenBotError("B:A_OP_TPL", { safeDetails: { provider: "gpt api_key=secret" } });
    assert.equal(formatTenBotError(unsafe), "[ERROR] B:A_OP_TPL Tool Protocol Leakage / 工具协议泄漏");
});

test("logger prints a TenBotError as the exact standard line without stringifying cause or context", () => {
    const previousLevel = getLogLevel();
    const originalError = console.error;
    const output: string[] = [];
    try {
        setLogLevel("error");
        console.error = (...values: unknown[]) => output.push(values.map(String).join(" "));
        logger.error("context with secret", new TenBotError("B:A_OP_TPL", { cause: new Error("raw secret") }));
    } finally {
        console.error = originalError;
        setLogLevel(previousLevel);
    }
    assert.deepEqual(output, ["[ERROR] B:A_OP_TPL Tool Protocol Leakage / 工具协议泄漏"]);
});

test("confirmed model-provider 5xx statuses map to remote codes; socket errors do not", () => {
    const cases = [
        [500, "R:A_MP_PIE"],
        [502, "R:A_MP_PBG"],
        [503, "R:A_MP_PSU"],
        [504, "R:A_MP_PGT"],
    ] as const;
    for (const [status, code] of cases) {
        const notice = createProviderErrorNotice("gpt", "gpt-6-sol", Object.assign(new Error("provider failed"), { status }));
        assert.equal(notice.tenbotCode, code);
        assert.equal(mapConfirmedRemoteHttpError("MP", status), code);
    }
    const socketError = Object.assign(new Error("socket reset"), { code: "ECONNRESET" });
    assert.equal(findExplicitHttpStatus(socketError), undefined);
    assert.equal(mapConfirmedRemoteHttpError("MP", findExplicitHttpStatus(socketError)), undefined);
    assert.equal(createProviderErrorNotice("gpt", "gpt-6-sol", socketError).tenbotCode, "M:A_MG_MRF");
});

test("QQ transport maps only explicit platform 5xx as Remote and distinguishes partial sends", () => {
    const cases = [
        [500, "R:A_QQ_QIE"],
        [502, "R:A_QQ_QBG"],
        [503, "R:A_QQ_QSU"],
        [504, "R:A_QQ_QGT"],
    ] as const;
    for (const [status, code] of cases) {
        assert.equal(createQqSendError(Object.assign(new Error("QQ failed"), { status }), 0).code, code);
    }
    assert.equal(createQqSendError(new Error("network failed"), 0).code, "B:A_QT_QSF");
    assert.equal(createQqSendError(new Error("network failed"), 1).code, "B:B_QT_PSF");
    assert.equal(createQqSendError(Object.assign(new Error("socket reset"), { code: "ECONNRESET" }), 0).code, "B:A_QT_QSF");
});
