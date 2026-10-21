import React from "react";
import { PanelHeading, SettingField } from "../settings-fields.js";
import type { SettingsPageProps } from "../settings-page-types.js";

export function JudgeSettings({ form, saving, fieldError, edit }: SettingsPageProps) {
    return <React.Fragment><section className="panel settings-panel settings-category-panel">
        <PanelHeading index="02" title="回复判断" hint="评估模型与判断策略" />
        <SettingField label="模型" id="setting-judge-model" error={fieldError("replyJudge.model")}><input id="setting-judge-model" type="text" value={form.values["replyJudge.model"]} disabled={saving} aria-invalid={Boolean(fieldError("replyJudge.model"))} onChange={(event) => edit("replyJudge.model", event.currentTarget.value)} /></SettingField>
        <SettingField label="超时" id="setting-judge-timeout" hint="单位：毫秒；允许范围 1000–30000。" error={fieldError("replyJudge.timeoutMs")}><input id="setting-judge-timeout" type="number" min="1000" max="30000" step="1" value={form.values["replyJudge.timeoutMs"]} disabled={saving} aria-invalid={Boolean(fieldError("replyJudge.timeoutMs"))} onChange={(event) => edit("replyJudge.timeoutMs", event.currentTarget.value)} /></SettingField>
        <div className="setting-toggle-row">
            <div className="setting-toggle-copy"><label htmlFor="setting-judge-ipo-fallback">评估模型异常时交由主模型判断</label><span id="setting-judge-ipo-fallback-hint">当评估模型返回无效协议输出时交给主模型自行判断；仅处理无效输出，不处理网络或服务商请求失败。</span></div>
            <input id="setting-judge-ipo-fallback" className="setting-toggle-input" type="checkbox" aria-describedby="setting-judge-ipo-fallback-hint" checked={form.values["replyJudge.fallbackToMainOnInvalidOutput"]} disabled={saving} onChange={(event) => edit("replyJudge.fallbackToMainOnInvalidOutput", event.currentTarget.checked)} />
        </div>
        <SettingField label="未完成发言等待时间" id="setting-judge-turn-wait" hint="单位：秒；允许范围 1–60 秒。" error={fieldError("replyJudge.turnWaitMs")}><input id="setting-judge-turn-wait" type="number" min="1" max="60" step="0.001" value={form.values["replyJudge.turnWaitMs"]} disabled={saving} aria-invalid={Boolean(fieldError("replyJudge.turnWaitMs"))} onChange={(event) => edit("replyJudge.turnWaitMs", event.currentTarget.value)} /></SettingField>
    </section></React.Fragment>;
}
