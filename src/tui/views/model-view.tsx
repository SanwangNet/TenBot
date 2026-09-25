import React from "react";
import { Box, Text } from "ink";
import type { RuntimeStatus } from "../../control/runtime-status.js";
import { configuredLabel, enabledLabel, providerLabel, reasoningLabel, verbosityLabel } from "../i18n.js";
import { Panel } from "../components/panel.js";
import { StatusRow } from "../components/status-row.js";

export function ModelView({ status }: { status: RuntimeStatus }) {
    return <Panel title="模型">
        <StatusRow label="模型提供商" value={providerLabel(status.provider.id)} />
        <StatusRow label="模型" value={status.provider.model} />
        <StatusRow label="推理强度" value={reasoningLabel(status.provider.reasoningEffort)} />
        <StatusRow label="输出详细度" value={verbosityLabel(status.provider.verbosity)} />
        <StatusRow label="联网搜索" value={enabledLabel(status.provider.webSearch)} />
        <StatusRow label="配置" value={configuredLabel(status.provider.configured)} color={status.provider.configured ? "green" : "yellow"} />
        <Text dimColor>模型提供商运行期间不可切换。</Text>
    </Panel>;
}
