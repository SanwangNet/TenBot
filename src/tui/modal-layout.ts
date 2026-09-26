export interface ModalBounds {
    left: number;
    top: number;
    width: number;
    height: number;
}

export function calculateCenteredModalBounds(
    columns: number,
    rows: number,
    requestedWidth: number,
    requestedHeight: number,
): ModalBounds {
    const terminalWidth = Math.max(1, Math.floor(columns));
    const terminalHeight = Math.max(1, Math.floor(rows));
    const width = Math.max(1, Math.min(Math.floor(requestedWidth), Math.max(1, terminalWidth - 4)));
    const height = Math.max(1, Math.min(Math.floor(requestedHeight), Math.max(1, terminalHeight - 2)));
    return {
        left: Math.max(0, Math.floor((terminalWidth - width) / 2)),
        top: Math.max(0, Math.floor((terminalHeight - height) / 2)),
        width,
        height,
    };
}
