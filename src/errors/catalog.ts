/** Stage IDs describe stable semantic phases; they never encode execution order. */
export const ERROR_STAGE_CATALOG = {
    F: { RJ: "Reply Judge" },
    M: {
        NS: "Network Search",
        IR: "Image Recognition",
        TL: "Tool Execution",
        MG: "Model Generation",
        IG: "Image Generation",
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
    "F:A_RJ_IPO": {
        english: "Invalid Protocol Output",
        chinese: "非法的协议输出",
    },
    "F:A_RJ_JRF": {
        english: "Reply Judge Request Failure",
        chinese: "回复判定请求失败",
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
    "M:C_IG_DSB": { english: "Image Generation Disabled", chinese: "AI 绘图未启用" },
    "M:C_IG_EPR": { english: "Image Prompt Required", chinese: "绘图提示词为空或过长" },
    "M:C_IG_IDN": { english: "Image Request Identity Missing", chinese: "绘图请求身份信息缺失" },
    "M:C_IG_DUP": { english: "Duplicate Image Request", chinese: "重复的绘图请求" },
    "M:C_IG_DQL": { english: "Image Daily Quota Reached", chinese: "AI 绘图每日额度已用完" },
    "M:C_IG_BSY": { english: "Member Image Request In Progress", chinese: "该成员已有绘图任务进行中" },
    "M:C_IG_GBL": { english: "Global Image Request In Progress", chinese: "全局绘图并发限制已达到" },
    "M:C_IG_CAN": { english: "Image Request Cancelled", chinese: "绘图请求已取消" },
    "M:C_IG_SZM": { english: "Generated Image Size Mismatch", chinese: "上游返回的图片尺寸与所选尺寸不一致" },
    "M:A_IG_CFG": { english: "Image Generation Configuration Invalid", chinese: "AI 绘图配置无效" },
    "M:A_IG_TFW": { english: "Image Temporary File Write Failure", chinese: "绘图临时文件写入失败" },
    "M:A_IG_IRS": { english: "Invalid Image Response", chinese: "上游图片响应无效" },
    "M:A_IG_STO": { english: "Image Request Storage Failure", chinese: "绘图请求状态存储失败" },
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
    "R:A_MP_AUF": { english: "Provider Authentication Rejected", chinese: "模型上游鉴权失败" },
    "R:A_MP_TMO": { english: "Provider Request Timed Out", chinese: "模型上游请求超时" },
    "R:A_MP_REQ": { english: "Provider Request Failure", chinese: "模型上游请求失败" },
    "R:C_MP_RAT": { english: "Provider Rate Limited", chinese: "模型上游请求过于频繁" },
    "R:C_MP_PAR": { english: "Provider Parameter Rejected", chinese: "模型上游不接受该参数组合" },
    "R:C_MP_SIZ": { english: "Provider Image Size Rejected", chinese: "绘图上游不支持所选尺寸" },
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
