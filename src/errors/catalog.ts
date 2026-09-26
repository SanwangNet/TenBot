/** Stage IDs describe stable semantic phases; they never encode execution order. */
export const ERROR_STAGE_CATALOG = {
    F: { RJ: "Reply Judge" },
    M: {
        NS: "Network Search",
        IR: "Image Recognition",
        TL: "Tool Execution",
        MG: "Model Generation",
    },
    B: {
        OP: "Output Protocol",
        RA: "Reply Action",
        QR: "Quote Resolution",
        MR: "Mention Rendering",
        QT: "QQ Transport",
    },
    R: {
        MP: "Model Provider",
        SP: "Search Provider",
        TP: "Tool Provider",
        QQ: "QQ Platform",
    },
} as const;

export const ERROR_CATALOG = {
    /** Reserved for a Reply Judge implementation; no judge is wired today. */
    "F:A_RJ_IPI": {
        english: "Invalid Protocol Input",
        chinese: "非法的协议输入",
    },
    /** Reserved policy definition: at most three network searches per 30-minute window. */
    "M:C_NS_NRL": {
        english: "Network Request Limit",
        chinese: "网络请求次数限制",
    },
    "M:A_MG_MTO": {
        english: "Model Timeout",
        chinese: "模型超时",
    },
    "M:A_MG_NVO": {
        english: "No Valid Output",
        chinese: "无有效输出",
    },
    "M:A_MG_IRS": {
        english: "Incomplete Response Stream",
        chinese: "响应流不完整",
    },
    "M:A_MG_MRF": {
        english: "Model Request Failure",
        chinese: "模型请求失败",
    },
    "M:B_TL_TEF": {
        english: "Tool Execution Failure",
        chinese: "工具执行失败",
    },
    "M:C_TL_TCL": {
        english: "Tool Call Limit",
        chinese: "工具调用次数限制",
    },
    "B:A_OP_TPL": {
        english: "Tool Protocol Leakage",
        chinese: "工具协议泄漏",
    },
    "B:A_RA_IRA": {
        english: "Invalid Reply Action",
        chinese: "非法回复动作",
    },
    "B:A_QT_QSF": {
        english: "QQ Send Failure",
        chinese: "QQ 发送失败",
    },
    "B:B_QT_PSF": {
        english: "Partial Send Failure",
        chinese: "部分发送失败",
    },
    "R:A_MP_PIE": {
        english: "Provider Internal Error",
        chinese: "模型提供商内部错误",
    },
    "R:A_MP_PBG": {
        english: "Provider Bad Gateway",
        chinese: "模型提供商网关错误",
    },
    "R:A_MP_PSU": {
        english: "Provider Service Unavailable",
        chinese: "模型提供商服务不可用",
    },
    "R:A_MP_PGT": {
        english: "Provider Gateway Timeout",
        chinese: "模型提供商网关超时",
    },
    "R:A_QQ_QIE": {
        english: "QQ Platform Internal Error",
        chinese: "QQ 平台内部错误",
    },
    "R:A_QQ_QBG": {
        english: "QQ Platform Bad Gateway",
        chinese: "QQ 平台网关错误",
    },
    "R:A_QQ_QSU": {
        english: "QQ Platform Service Unavailable",
        chinese: "QQ 平台服务不可用",
    },
    "R:A_QQ_QGT": {
        english: "QQ Platform Gateway Timeout",
        chinese: "QQ 平台网关超时",
    },
} as const;

export type TenBotErrorCode = keyof typeof ERROR_CATALOG;

export function isTenBotErrorCode(value: unknown): value is TenBotErrorCode {
    return typeof value === "string" && Object.hasOwn(ERROR_CATALOG, value);
}
