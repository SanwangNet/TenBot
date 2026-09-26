import React from "react";
import { Box, Text } from "ink";
import type { RuntimeStatus } from "../../control/runtime-status.js";
import { connectionColor, connectionLabel, configuredLabel, enabledLabel, formatDateTime, providerLabel, reasoningLabel, verbosityLabel } from "../i18n.js";
import { Panel } from "../components/panel.js";
import { StatusRow } from "../components/status-row.js";

export function OverviewView({ status }: { status: RuntimeStatus }) {
    return <Box flexDirection="column">
        <Panel title="运行状态">
            <StatusRow label="QQ" value={connectionLabel(status.qq)} color={connectionColor(status.qq)} />
            <StatusRow label="群回复" value={status.groupRepliesEnabled ? "已启用" : "已停用"} color={status.groupRepliesEnabled ? "green" : "yellow"} />
            <StatusRow label="模型提供商" value={providerLabel(status.provider.id)} />
            <StatusRow label="模型" value={status.provider.model} />
            <StatusRow label="推理强度" value={reasoningLabel(status.provider.reasoningEffort)} />
            <StatusRow label="输出详细度" value={verbosityLabel(status.provider.verbosity)} />
            <StatusRow label="联网搜索" value={enabledLabel(status.provider.webSearch)} />
            <StatusRow label="活动周期" value={`${status.activeCycles} 个`} />
            <StatusRow label="上下文" value={`${status.contextConversations} 个会话`} />
        </Panel>
        <Panel title="数据">
            <StatusRow label="提示词" value={`版本 ${status.prompt.revision} · ${formatDateTime(status.prompt.loadedAt)}`} />
            <StatusRow label="梗数据" value={`${status.memes.count} 条 · 版本 ${status.memes.revision} · ${formatDateTime(status.memes.loadedAt)}`} />
            <StatusRow label="配置" value={configuredLabel(status.provider.configured)} color={status.provider.configured ? "green" : "yellow"} />
        </Panel>
        {!status.provider.configured ? <Text color="yellow">! 模型提供商凭据未配置，回复请求可能失败。</Text> : null}
    </Box>;
}
