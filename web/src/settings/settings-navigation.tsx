import React from "react";
import type { SettingsSection } from "../navigation.js";

export const SETTINGS_PAGES: readonly { id: SettingsSection; label: string; title: string; description: string }[] = [
    { id: "model", label: "模型配置", title: "模型配置", description: "管理 GPT 与 DeepSeek 预设、模型选择和生成参数。" },
    { id: "judge", label: "回复判断", title: "回复判断", description: "配置 Reply Judge 模型、等待时间和判断策略。" },
    { id: "runtime", label: "运行与媒体", title: "运行与媒体", description: "管理运行时循环保护和表情包发送尺寸。" },
    { id: "image", label: "AI 绘图", title: "AI 绘图", description: "配置 /绘图 使用的模型、质量、尺寸和输出格式。" },
];

export function SettingsNavigation({
    section,
    dirtySections,
    onChange,
}: {
    section: SettingsSection;
    dirtySections: ReadonlySet<SettingsSection>;
    onChange(section: SettingsSection): void;
}) {
    return <React.Fragment><nav className="settings-navigation" aria-label="设置分类">
        {SETTINGS_PAGES.map((page) => <button
            key={page.id}
            type="button"
            className={`settings-nav-item${section === page.id ? " active" : ""}`}
            aria-current={section === page.id ? "page" : undefined}
            aria-pressed={section === page.id}
            onClick={() => onChange(page.id)}
        >
            <span>{page.label}</span>
            {dirtySections.has(page.id) && <span className="settings-nav-dirty" aria-label="有未保存更改" title="有未保存更改" />}
        </button>)}
    </nav></React.Fragment>;
}

export function SettingsSubheading({ section }: { section: SettingsSection }) {
    const page = SETTINGS_PAGES.find((item) => item.id === section) ?? SETTINGS_PAGES[0]!;
    return <React.Fragment><div className="settings-subheading">
        <div><h2>{page.title}</h2><p>{page.description}</p></div>
    </div></React.Fragment>;
}
