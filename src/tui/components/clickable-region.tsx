import React, { useEffect, useRef } from "react";
import { Box, measureElement, useBoxMetrics } from "ink";
import type { DOMElement, BoxProps } from "ink";
import type { ClickableRegionRegistry } from "../mouse-input.js";

export function ClickableRegion({
    id,
    registry,
    onClick,
    modal = false,
    children,
    ...boxProps
}: BoxProps & {
    id: string;
    registry: ClickableRegionRegistry;
    onClick(): void;
    modal?: boolean;
    children: React.ReactNode;
}) {
    const ref = useRef<DOMElement | null>(null);
    const metrics = useBoxMetrics(ref);

    useEffect(() => {
        if (!metrics.hasMeasured || !ref.current) return;
        const bounds = measureElement(ref.current);
        if (bounds.width <= 0 || bounds.height <= 0) return;
        return registry.register({
            id,
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height,
            modal,
            action: onClick,
        });
    }, [id, metrics.hasMeasured, metrics.height, metrics.left, metrics.top, metrics.width, modal, onClick, registry]);

    return <Box ref={ref} {...boxProps}>{children}</Box>;
}
