import React, { type ReactNode } from "react";
import type { ImageGenerationQuality } from "../api/types.js";

export function PanelHeading({ index, title, hint }: { index: string; title: string; hint: string }) {
    return <React.Fragment><div className="panel-heading">
        <div className="panel-title"><span className="panel-index">{index}</span><h2>{title}</h2></div>
        <span className="panel-hint">{hint}</span>
    </div></React.Fragment>;
}

export function SettingField({ label, id, hint, error, children }: { label: string; id: string; hint?: string; error?: string; children: ReactNode }) {
    return <React.Fragment><div className="setting-field">
        <label htmlFor={id}>{label}</label>
        {children}
        {error ? <span className="field-error">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
    </div></React.Fragment>;
}

export function imageQualityLabel(value: ImageGenerationQuality): string {
    const labels: Record<ImageGenerationQuality, string> = {
        low: "低", medium: "中", high: "高", xhigh: "极高", max: "最高", auto: "自动", standard: "标准", hd: "高清",
    };
    return `${labels[value]}（${value}）`;
}

export function imageSizeLabel(value: string): string {
    if (value === "auto") return "自动（由绘图模型决定）";
    return value.replace("x", " × ");
}
