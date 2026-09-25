import React from "react";
import { Box, Text } from "ink";
import type { PublicConfig } from "../../config/config-types.js";
import type { RuntimeStatus } from "../../control/runtime-status.js";
import { logLevelLabel, providerLabel, reasoningLabel, settingsFieldLabel, verbosityLabel } from "../i18n.js";
import { Panel } from "../components/panel.js";
import { StatusRow } from "../components/status-row.js";
import { SETTINGS_FIELDS, type SettingsField } from "../state.js";
import { ClickableRegion } from "../components/clickable-region.js";
import type { ClickableRegionRegistry } from "../mouse-input.js";

export function SettingsView({ status, config, selectedIndex, pendingRestart, registry, onEdit }: {
    status: RuntimeStatus;
    config: PublicConfig;
    selectedIndex: number;
    pendingRestart: boolean;
    registry: ClickableRegionRegistry;
    onEdit(index: number): void;
}) {
    const valueFor = (field: SettingsField): string => {
        switch (field) {
            case "aiProvider": return providerLabel(config.aiProvider);
            case "gpt.model": return config.gpt.model;
            case "gpt.reasoningEffort": return reasoningLabel(config.gpt.reasoningEffort);
            case "gpt.verbosity": return verbosityLabel(config.gpt.verbosity);
            case "deepseek.model": return config.deepseek.model;
            case "deepseek.reasoningEffort": return reasoningLabel(config.deepseek.reasoningEffort);
            case "logLevel": return logLevelLabel(config.logLevel);
            case "botLoopGuard.maxCycles": return String(config.botLoopGuard.maxCycles);
        }
    };

    const editableRow = (field: SettingsField, index: number) => <ClickableRegion key={field} id={`settings:${field}`} registry={registry} width="100%" flexShrink={0} onClick={() => onEdit(index)}>
        <Box flexDirection="row">
            <Text color={selectedIndex === index ? "cyan" : undefined}>{selectedIndex === index ? "› " : "  "}</Text>
            <Box width={23}><Text dimColor={selectedIndex !== index}>{settingsFieldLabel(field)}</Text></Box>
            <Text>{valueFor(field)}</Text>
        </Box>
    </ClickableRegion>;

    return <Panel>
        {pendingRestart ? <Text color="yellow">! 部分配置将在下次启动后生效。</Text> : null}
        <Text bold>模型</Text>
        {SETTINGS_FIELDS.slice(0, 6).map((field, index) => editableRow(field, index))}
        <Text> </Text>
        <Text bold>运行</Text>
        {editableRow("logLevel", 6)}
        {editableRow("botLoopGuard.maxCycles", 7)}
        <Text> </Text>
        <Text bold>自动账号</Text>
        <StatusRow label="已登记" value={`${config.botLoopGuard.automatedPeerCount} 个`} />
        <StatusRow label="配置文件" value=".env" />
    </Panel>;
}
