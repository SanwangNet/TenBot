import React from "react";
import { Box, Text } from "ink";
import type { RuntimeStatus } from "../../control/runtime-status.js";
import { formatDateTime, providerLabel } from "../i18n.js";
import { Panel } from "../components/panel.js";
import { StatusRow } from "../components/status-row.js";

export function PromptView({ status }: { status: RuntimeStatus }) {
    const preview = `当前模型提供商：${providerLabel(status.prompt.provider)}`;
    return <Box flexDirection="column">
        <Panel title="提示词">
            <StatusRow label="模型提供商" value={providerLabel(status.prompt.provider)} />
            <StatusRow label="版本" value={`版本 ${status.prompt.revision}`} />
            <StatusRow label="加载时间" value={formatDateTime(status.prompt.loadedAt)} />
            <StatusRow label="文件路径" value={status.prompt.path ?? `src/ai/plugins/${status.prompt.provider}/prompt.md`} />
            <StatusRow label="字符数" value={`${status.prompt.characters ?? "未知"} · ${status.prompt.lines ?? "未知"} 行`} />
        </Panel>
        <Panel title="预览">
            <Text color="cyan">{preview}</Text>
            <Text dimColor>提示词内容仍由外部编辑器维护。</Text>
        </Panel>
    </Box>;
}
