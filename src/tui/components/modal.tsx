import React from "react";
import { Box, Text } from "ink";
import type { ModalState } from "../state.js";

function ModalFrame({ title, children, width }: { title: string; children: React.ReactNode; width: number }) {
    return <Box position="absolute" left={2} top={2} width={width} flexDirection="column" borderStyle="double" paddingX={2} paddingY={1} backgroundColor="black">
        <Text bold color="cyan">{title}</Text>
        {children}
    </Box>;
}

export function ModalLayer({ modal, columns }: { modal: ModalState; columns: number }) {
    if (modal.type === "none") return null;
    const width = Math.max(30, Math.min(72, columns - 4));
    if (modal.type === "help") {
        return <ModalFrame title="帮助" width={width}>
            <Text>↑ ↓    选择</Text>
            <Text>Enter  打开</Text>
            <Text>Esc    返回</Text>
            <Text>P      重载提示词</Text>
            <Text>M      重载梗数据</Text>
            <Text>R      重载全部数据</Text>
            <Text>Q      退出 TenBot</Text>
            <Text> </Text>
            <Text dimColor>Enter / Esc 关闭</Text>
        </ModalFrame>;
    }
    if (modal.type === "reload-confirm") {
        return <ModalFrame title="确认重载" width={width}>
            <Text>确定重新加载提示词和梗数据吗？</Text>
            <Text> </Text>
            <Text dimColor>Enter 确认 · Esc 取消</Text>
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
            <Text dimColor>Enter / Esc 关闭</Text>
        </ModalFrame>;
    }
    if (modal.type === "config-select") {
        return <ModalFrame title={modal.title} width={width}>
            {modal.options.map((option, index) => <Text key={option.value} color={index === modal.index ? "cyan" : undefined}>
                {index === modal.index ? "› " : "  "}{option.label}
            </Text>)}
            <Text> </Text>
            <Text dimColor>↑↓ 选择 · Enter 确认 · Esc 取消</Text>
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
            <Text dimColor>Enter 下一步 · Esc 取消</Text>
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
            <Text color="yellow">修改后需要重启 TenBot。</Text>
            <Text> </Text>
            <Text dimColor>Enter 保存 · Esc 取消</Text>
        </ModalFrame>;
    }
    if (modal.type === "config-invalid") {
        return <ModalFrame title="配置无效" width={width}>
            <Text color="red">✕ {modal.message}</Text>
            <Text> </Text>
            <Text dimColor>Enter / Esc 返回</Text>
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
            <Text dimColor>Enter / Esc 关闭</Text>
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
            <Text dimColor>Enter / Esc 返回</Text>
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
        <Text dimColor>D 详情 · Enter / Esc 关闭</Text>
    </ModalFrame>;
}
