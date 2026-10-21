import React from "react";
import { PanelHeading, SettingField } from "../settings-fields.js";
import type { SettingsPageProps } from "../settings-page-types.js";

const memeSendSizeOptions = [[96, "96 px"], [128, "128 px"], [160, "160 px"], [200, "200 px"], [240, "240 px"]] as const;
const memeSendPresetValues = new Set(memeSendSizeOptions.map(([value]) => String(value)));

export function RuntimeSettings({ form, saving, fieldError, edit }: SettingsPageProps) {
    return <React.Fragment><section className="panel settings-panel settings-category-panel">
        <PanelHeading index="03" title="运行与媒体" hint="保存后由运行时热重载应用" />
        <SettingField label="表情包发送大小" id="setting-meme-send-size" hint="机器人实际发送时的最大边长；不会修改本地原始文件。">
            <select id="setting-meme-send-size" value={form.values.memeSendMaxEdge} disabled={saving} onChange={(event) => edit("memeSendMaxEdge", event.currentTarget.value)}>
                <option value="original">原始尺寸</option>
                {memeSendSizeOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                {form.values.memeSendMaxEdge !== "original" && !memeSendPresetValues.has(form.values.memeSendMaxEdge) && <option value={form.values.memeSendMaxEdge}>{form.values.memeSendMaxEdge} px（自定义）</option>}
            </select>
            <input type="number" min="32" max="1024" step="1" aria-label="自定义表情包发送边长，32 到 1024 px" placeholder="自定义边长：32–1024 px" value={form.values.memeSendMaxEdge === "original" || memeSendPresetValues.has(form.values.memeSendMaxEdge) ? "" : form.values.memeSendMaxEdge} disabled={saving} aria-invalid={Boolean(fieldError("memeSendMaxEdge"))} onChange={(event) => edit("memeSendMaxEdge", event.currentTarget.value)} />
        </SettingField>
        <SettingField label="机器人循环保护 · 最大轮次" id="setting-max-cycles" hint="最小值为 1；后端进行最终校验。" error={fieldError("botLoopGuard.maxCycles")}><input id="setting-max-cycles" type="number" min="1" step="1" value={form.values["botLoopGuard.maxCycles"]} disabled={saving} aria-invalid={Boolean(fieldError("botLoopGuard.maxCycles"))} onChange={(event) => edit("botLoopGuard.maxCycles", event.currentTarget.value)} /></SettingField>
    </section></React.Fragment>;
}
