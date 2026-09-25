import React from "react";
import { Box, Text } from "ink";
import type { AutomatedPeerSummary } from "../../control/automated-peers.js";
import type { ModalState } from "../state.js";
import { ClickableRegion } from "./clickable-region.js";
import type { ClickableRegionRegistry } from "../mouse-input.js";

interface ModalActionsProps {
    registry: ClickableRegionRegistry;
    onConfirm(): void;
    onCancel?: () => void;
    confirmLabel?: string;
    cancelLabel?: string;
}

function ModalActions({ registry, onConfirm, onCancel, confirmLabel = "确认", cancelLabel = "取消" }: ModalActionsProps) {
    return <Box flexDirection="row" flexShrink={0}>
        <ClickableRegion id="modal:confirm" registry={registry} modal paddingX={1} onClick={onConfirm}>
            <Text color="green">[ {confirmLabel} ]</Text>
        </ClickableRegion>
        {onCancel ? <>
            <Text>  </Text>
            <ClickableRegion id="modal:cancel" registry={registry} modal paddingX={1} onClick={onCancel}>
                <Text color="yellow">[ {cancelLabel} ]</Text>
            </ClickableRegion>
        </> : null}
    </Box>;
}

function ModalFrame({ title, children, width }: { title: string; children: React.ReactNode; width: number }) {
    return <Box position="absolute" left={2} top={2} width={width} flexDirection="column" borderStyle="double" paddingX={2} paddingY={1} backgroundColor="black">
        <Text bold color="cyan">{title}</Text>
        {children}
    </Box>;
}

function PeerDetails({ peer, registered, maxCycles }: { peer: AutomatedPeerSummary; registered: boolean; maxCycles: number }) {
    return <>
        <Text>名称       {peer.displayName}</Text>
        <Text wrap="wrap">稳定 ID   {peer.id}</Text>
        <Text>类型       {registered ? "Bot" : "普通账号"}</Text>
        <Text>平台标记   {peer.platformBotHint ? "Bot" : "无"}</Text>
        <Text>最近出现   {peer.lastSeenAt ? new Date(peer.lastSeenAt).toLocaleTimeString("zh-CN", { hour12: false }) : "未知"}</Text>
        <Text>自动互聊保护   {registered ? "已启用" : "未启用"}</Text>
        <Text>连续交互上限   {maxCycles}（全局）</Text>
    </>;
}

export function ModalLayer({
    modal,
    columns,
    registry,
    onClose,
    onConfirm,
    onOption,
    onProviderDetails,
    onAddPeer,
    onRemovePeer,
    maxCycles,
}: {
    modal: ModalState;
    columns: number;
    registry: ClickableRegionRegistry;
    onClose(): void;
    onConfirm(): void;
    onOption(index: number): void;
    onProviderDetails(): void;
    onAddPeer(peer: AutomatedPeerSummary): void;
    onRemovePeer(peer: AutomatedPeerSummary): void;
    maxCycles: number;
}) {
    if (modal.type === "none") return null;
    const width = Math.max(24, Math.min(72, columns - 4));
    if (modal.type === "help") {
        return <ModalFrame title="帮助" width={width}>
            <Text>↑ ↓    选择</Text>
            <Text>Enter  打开</Text>
            <Text>Esc    返回</Text>
            <Text>P      重载提示词</Text>
            <Text>M      重载梗数据</Text>
            <Text>R      重载全部数据</Text>
            <Text>Q      打开退出确认</Text>
            <Text> </Text>
            <ModalActions registry={registry} onConfirm={onClose} confirmLabel="关闭" />
        </ModalFrame>;
    }
    if (modal.type === "quit-confirm") {
        return <ModalFrame title="退出 TenBot" width={width}>
            <Text>确定要停止 TenBot 并退出吗？</Text>
            <Text>QQ 连接和当前运行时将关闭。</Text>
            <Text> </Text>
            <ModalActions registry={registry} onConfirm={onConfirm} confirmLabel="确认退出" onCancel={onClose} />
            <Text dimColor>Enter 确认 · Esc 取消</Text>
        </ModalFrame>;
    }
    if (modal.type === "reload-confirm") {
        return <ModalFrame title="确认重载" width={width}>
            <Text>确定重新加载提示词和梗数据吗？</Text>
            <Text> </Text>
            <ModalActions registry={registry} onConfirm={onConfirm} onCancel={onClose} />
        </ModalFrame>;
    }
    if (modal.type === "reload-result") {
        const allOk = modal.promptOk && modal.memesOk;
        return <ModalFrame title={allOk ? "重载完成" : "重载失败"} width={width}>
            {modal.target !== "memes" ? <>
                <Text color={modal.promptOk ? "green" : "red"}>{modal.promptOk ? "✓ 提示词已重载" : "✕ 提示词重载失败"}</Text>
                {modal.promptRevision !== undefined ? <Text dimColor>  版本 {modal.promptRevision}</Text> : null}
            </> : null}
            {modal.target !== "prompt" ? <>
                <Text color={modal.memesOk ? "green" : "red"}>{modal.memesOk ? "✓ 梗数据已重载" : "✕ 梗数据读取失败"}</Text>
                {modal.memeRevision !== undefined ? <Text dimColor>  {modal.memeCount ?? "?"} 条 · 版本 {modal.memeRevision}</Text> : null}
            </> : null}
            {modal.message ? <Text color="yellow">{modal.message}</Text> : null}
            {!modal.promptOk || !modal.memesOk ? <Text dimColor>已继续使用旧版本。</Text> : null}
            <Text> </Text>
            <ModalActions registry={registry} onConfirm={onClose} confirmLabel="关闭" />
        </ModalFrame>;
    }
    if (modal.type === "config-select") {
        return <ModalFrame title={modal.title} width={width}>
            {modal.options.map((option, index) => <ClickableRegion key={option.value} id={`modal:option:${option.value}`} registry={registry} modal width="100%" flexShrink={0} onClick={() => onOption(index)}>
                <Text color={index === modal.index ? "cyan" : undefined}>{index === modal.index ? "› " : "  "}{option.label}</Text>
            </ClickableRegion>)}
            <Text> </Text>
            <ModalActions registry={registry} onConfirm={onConfirm} onCancel={onClose} />
        </ModalFrame>;
    }
    if (modal.type === "config-text") {
        const before = modal.value.slice(0, modal.cursor);
        const after = modal.value.slice(modal.cursor);
        return <ModalFrame title={modal.title} width={width}>
            <Text> </Text>
            <Text>{before}<Text color="cyan">█</Text>{after}</Text>
            <Text> </Text>
            <Text dimColor>输入文字 · Backspace 删除 · ← → 移动</Text>
            <ModalActions registry={registry} onConfirm={onConfirm} onCancel={onClose} confirmLabel="下一步" />
        </ModalFrame>;
    }
    if (modal.type === "config-confirm") {
        return <ModalFrame title="确认修改" width={width}>
            <Text>{modal.label}</Text>
            <Text> </Text>
            <Text>{modal.from}</Text>
            <Text color="cyan">↓</Text>
            <Text>{modal.to}</Text>
            <Text> </Text>
            <Text color="yellow">确认后将立即热重载运行配置。</Text>
            <Text> </Text>
            <ModalActions registry={registry} onConfirm={onConfirm} onCancel={onClose} confirmLabel="保存" />
        </ModalFrame>;
    }
    if (modal.type === "config-invalid") {
        return <ModalFrame title="配置无效" width={width}>
            <Text color="red">✕ {modal.message}</Text>
            <Text> </Text>
            <ModalActions registry={registry} onConfirm={onClose} confirmLabel="返回" />
        </ModalFrame>;
    }
    if (modal.type === "config-result") {
        return <ModalFrame title={modal.result.ok ? "配置已保存" : "配置保存失败"} width={width}>
            <Text color={modal.result.ok ? "green" : "red"}>{modal.result.ok ? "✓" : "✕"} {modal.label}</Text>
            <Text> </Text>
            <Text>{modal.result.message}</Text>
            {modal.result.ok && modal.result.requiresRestart ? <Text color="yellow">需要重启 TenBot 后生效。</Text> : null}
            {!modal.result.ok && modal.result.details ? <Text dimColor>{modal.result.details}</Text> : null}
            <Text> </Text>
            <ModalActions registry={registry} onConfirm={onClose} confirmLabel="关闭" />
        </ModalFrame>;
    }
    if (modal.type === "automated-peer-details") {
        return <ModalFrame title="自动账号详情" width={width}>
            <PeerDetails peer={modal.peer} registered={modal.registered} maxCycles={maxCycles} />
            <Text> </Text>
            <ModalActions
                registry={registry}
                onConfirm={modal.registered ? () => onRemovePeer(modal.peer) : () => onAddPeer(modal.peer)}
                onCancel={onClose}
                confirmLabel={modal.registered ? "取消 Bot" : "设为 Bot"}
                cancelLabel="关闭"
            />
        </ModalFrame>;
    }
    if (modal.type === "automated-peer-confirm") {
        const add = modal.action === "add";
        return <ModalFrame title={add ? "添加自动账号" : "删除自动账号"} width={width}>
            <Text>名称       {modal.peer.displayName}</Text>
            <Text wrap="wrap">稳定 ID   {modal.peer.id}</Text>
            <Text> </Text>
            <Text>{add ? "加入后，该账号产生的新回复周期将受到自动互聊保护限制。" : "删除后，该账号将不再被视为已登记自动账号。"}</Text>
            <Text> </Text>
            <ModalActions registry={registry} onConfirm={onConfirm} onCancel={onClose} confirmLabel={add ? "添加" : "删除"} />
        </ModalFrame>;
    }
    if (modal.type === "automated-peer-result") {
        const success = modal.result.ok;
        return <ModalFrame title={success ? "自动账号已更新" : "操作失败"} width={width}>
            <Text color={success ? "green" : "red"}>{success ? "✓" : "✕"} {modal.result.message}</Text>
            {modal.result.details ? <Text dimColor>{modal.result.details}</Text> : null}
            <Text> </Text>
            <ModalActions registry={registry} onConfirm={onClose} confirmLabel="关闭" />
        </ModalFrame>;
    }
    const notice = modal.notice;
    if (modal.type === "provider-error-details") {
        return <ModalFrame title="模型提供商错误 · 详情" width={width}>
            <Text>模型提供商  {notice.provider}</Text>
            <Text>模型          {notice.model}</Text>
            <Text> </Text>
            <Text wrap="truncate">{notice.details ?? "暂无更多安全详情。"}</Text>
            {modal.count > 1 ? <Text color="yellow">另有 {modal.count - 1} 个模型错误</Text> : null}
            <Text> </Text>
            <ModalActions registry={registry} onConfirm={onClose} confirmLabel="返回" />
        </ModalFrame>;
    }
    return <ModalFrame title="模型提供商错误" width={width}>
        <Text color="red">✕ {notice.provider} 请求失败</Text>
        <Text> </Text>
        <Text>模型        {notice.model}</Text>
        <Text>HTTP 状态   {notice.status ?? "未知"}</Text>
        <Text>错误代码    {notice.code ?? "未知"}</Text>
        <Text>可重试      {notice.retryable === undefined ? "未知" : notice.retryable ? "是" : "否"}</Text>
        <Text> </Text>
        <Text wrap="truncate">{notice.message}</Text>
        {modal.count > 1 ? <Text color="yellow">另有 {modal.count - 1} 个模型错误</Text> : null}
        <Text> </Text>
        <Box flexDirection="row">
            <ClickableRegion id="modal:details" registry={registry} modal paddingX={1} onClick={onProviderDetails}><Text color="cyan">[ 详情 ]</Text></ClickableRegion>
            <Text>  </Text>
            <ClickableRegion id="modal:confirm" registry={registry} modal paddingX={1} onClick={onClose}><Text color="green">[ 关闭 ]</Text></ClickableRegion>
        </Box>
    </ModalFrame>;
}
