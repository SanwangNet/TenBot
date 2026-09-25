import React from "react";
import { Box, Text } from "ink";
import type { ModelProviderId, PublicConfig } from "../../config/config-types.js";
import type { RuntimeStatus } from "../../control/runtime-status.js";
import { MODEL_PROVIDERS } from "../../ai/model-registry.js";
import { logLevelLabel, reasoningLabel, settingsFieldLabel, verbosityLabel } from "../i18n.js";
import { Panel } from "../components/panel.js";
import { StatusRow } from "../components/status-row.js";
import type { SettingsField } from "../state.js";
import { ClickableRegion } from "../components/clickable-region.js";
import type { ClickableRegionRegistry } from "../mouse-input.js";

export function SettingsView({ status, config, selectedIndex, pendingRestart, viewedProvider, registry, onEdit, onViewProvider, onApplyProvider }: {
    status: RuntimeStatus;
    config: PublicConfig;
    selectedIndex: number;
    pendingRestart: boolean;
    viewedProvider: ModelProviderId;
    registry: ClickableRegionRegistry;
    onEdit(field: SettingsField): void;
    onViewProvider(delta: number): void;
    onApplyProvider(): void;
}) {
    const provider = config[viewedProvider];
    const fields: SettingsField[] = viewedProvider === "gpt"
        ? ["gpt.model", "gpt.reasoningEffort", "gpt.verbosity"]
        : ["deepseek.model", "deepseek.reasoningEffort"];
    const rows: Array<SettingsField | "provider" | "apply"> = ["provider", ...fields, "apply", "logLevel", "botLoopGuard.maxCycles"];
    const selected = (index: number) => selectedIndex === index;
    const valueFor = (field: SettingsField): string => {
        switch (field) {
            case "gpt.model": return config.gpt.model;
            case "gpt.reasoningEffort": return reasoningLabel(config.gpt.reasoningEffort);
            case "gpt.verbosity": return verbosityLabel(config.gpt.verbosity);
            case "deepseek.model": return config.deepseek.model;
            case "deepseek.reasoningEffort": return reasoningLabel(config.deepseek.reasoningEffort);
            case "logLevel": return logLevelLabel(config.logLevel);
            case "botLoopGuard.maxCycles": return String(config.botLoopGuard.maxCycles);
        }
        return "";
    };

    const editableRow = (field: SettingsField, index: number, width: number) => <ClickableRegion key={field} id={`settings:${field}`} registry={registry} width="100%" flexShrink={0} onClick={() => onEdit(field)}>
        <Box flexDirection="row">
            <Text color={selected(index) ? "cyan" : undefined}>{selected(index) ? "› " : "  "}</Text>
            <Box width={width}><Text dimColor={!selected(index)}>{settingsFieldLabel(field)}</Text></Box>
            <Text>{valueFor(field)}</Text>
        </Box>
    </ClickableRegion>;

    return <Panel>
        {pendingRestart ? <Text color="yellow">! 部分配置将在下次启动后生效。</Text> : null}
        <Text bold>模型提供商</Text>
        <Box flexDirection="row" justifyContent="center" width="100%">
            <ClickableRegion id="settings:provider-previous" registry={registry} paddingX={2} onClick={() => onViewProvider(-1)}>
                <Text color="cyan">◀</Text>
            </ClickableRegion>
            <Text color={selected(0) ? "cyan" : undefined}>{selected(0) ? "› " : "  "}<Text bold>{MODEL_PROVIDERS.find((item) => item.id === viewedProvider)?.label ?? viewedProvider}</Text></Text>
            <ClickableRegion id="settings:provider-next" registry={registry} paddingX={2} onClick={() => onViewProvider(1)}>
                <Text color="cyan">▶</Text>
            </ClickableRegion>
        </Box>
        <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
            {fields.map((field, index) => editableRow(field, index + 1, 20))}
            <Text dimColor>配置状态  {provider.configured ? "已配置" : "未配置"}</Text>
            <Text dimColor>{status.provider.id === viewedProvider ? "● 当前运行" : "○ 未在运行"}</Text>
            <ClickableRegion id="settings:apply-provider" registry={registry} width="100%" flexShrink={0} onClick={onApplyProvider}>
                <Text color={selected(1 + fields.length) ? "cyan" : "green"}>{selected(1 + fields.length) ? "› " : "  "}[设为当前模型提供商]</Text>
            </ClickableRegion>
        </Box>
        <Text> </Text>
        <Text bold>运行</Text>
        {editableRow("logLevel", rows.indexOf("logLevel"), 20)}
        {editableRow("botLoopGuard.maxCycles", rows.indexOf("botLoopGuard.maxCycles"), 20)}
        <Text> </Text>
        <Text bold>自动账号</Text>
        <StatusRow label="已登记" value={`${config.botLoopGuard.automatedPeerCount} 个`} />
        <StatusRow label="配置文件" value=".env" />
        <StatusRow label="热重载" value={status.hotReload?.enabled ? "已启用" : "不可用"} />
        {status.hotReload ? <StatusRow label="配置版本" value={`版本 ${status.hotReload.revision}`} /> : null}
    </Panel>;
}
