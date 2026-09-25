import React from "react";
import { Box, Text } from "ink";
import type { RuntimeStatus } from "../../control/runtime-status.js";
import { formatDateTime } from "../i18n.js";
import { Panel } from "../components/panel.js";
import { StatusRow } from "../components/status-row.js";

export function MemesView({ status }: { status: RuntimeStatus }) {
    return <Box flexDirection="column">
        <Panel title="梗数据">
            <StatusRow label="条目数量" value={`${status.memes.count} 条`} />
            <StatusRow label="版本" value={`版本 ${status.memes.revision}`} />
            <StatusRow label="加载时间" value={formatDateTime(status.memes.loadedAt)} />
            <StatusRow label="文件路径" value={status.memes.path ?? "src/skills/meme/data/memes.json"} />
        </Panel>
        <Panel title="最近条目">
            {status.memes.sampleNames?.length
                ? status.memes.sampleNames.map((name) => <Text key={name}>› {name}</Text>)
                : <Text dimColor>暂无条目预览</Text>}
            <Text dimColor>完整 JSON 仍由外部编辑器维护。</Text>
        </Panel>
    </Box>;
}
