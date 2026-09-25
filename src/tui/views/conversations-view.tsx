import React from "react";
import { Text } from "ink";
import type { RuntimeStatus } from "../../control/runtime-status.js";
import { Panel } from "../components/panel.js";
import { StatusRow } from "../components/status-row.js";

export function ConversationsView({ status }: { status: RuntimeStatus }) {
    return <Panel title="对话">
        <StatusRow label="上下文会话" value={`${status.contextConversations} 个`} />
        <StatusRow label="活动周期" value={`${status.activeCycles} 个`} />
        <Text dimColor>对话详情将在后续版本提供。</Text>
    </Panel>;
}
