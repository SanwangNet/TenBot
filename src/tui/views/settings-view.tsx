import React from "react";
import { Text } from "ink";
import type { RuntimeStatus } from "../../control/runtime-status.js";
import { Panel } from "../components/panel.js";
import { StatusRow } from "../components/status-row.js";

export function SettingsView({ status }: { status: RuntimeStatus }) {
    return <Panel title="设置">
        <StatusRow label="运行模式" value="本地 QQ 运行时" />
        <StatusRow label="日志级别" value="由 BOT_LOG_LEVEL 决定" />
        <StatusRow label="提示词路径" value={status.prompt.path ?? "src/ai/plugins/<provider>/prompt.md"} />
        <StatusRow label="梗数据路径" value={status.memes.path ?? "src/skills/meme/data/memes.json"} />
        <Text dimColor>提示词与梗数据支持热加载；TUI 当前不支持运行时切换模型提供商。</Text>
    </Panel>;
}
