import React from "react";
import { Box } from "ink";
import type { RuntimeStatus } from "../../control/runtime-status.js";
import { formatDateTime, providerLabel } from "../i18n.js";
import { Panel } from "../components/panel.js";
import { StatusRow } from "../components/status-row.js";
import { splitDisplayPath } from "../path-display.js";

export function PromptView({ status }: { status: RuntimeStatus }) {
    const { fileName, directory } = splitDisplayPath(status.prompt.path ?? `src/ai/plugins/${status.prompt.provider}/prompt.md`);
    return <Box flexDirection="column">
        <Panel title="提示词">
            <StatusRow label="模型提供商" value={providerLabel(status.prompt.provider)} />
            <StatusRow label="版本" value={`版本 ${status.prompt.revision}`} />
            <StatusRow label="加载时间" value={formatDateTime(status.prompt.loadedAt)} />
            <StatusRow label="字符数" value={`${status.prompt.characters ?? "未知"} · ${status.prompt.lines ?? "未知"} 行`} />
        </Panel>
        <Panel title="正在使用">
            <StatusRow label="文件" value={fileName} />
            <StatusRow label="目录" value={directory} />
        </Panel>
    </Box>;
}
