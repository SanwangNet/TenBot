export interface MouseClick {
    x: number;
    y: number;
    button: "left";
}

export function isSgrMouseSequence(value: string): boolean {
    return /^(?:\u001b)?\[<\d+;\d+;\d+[Mm]$/.test(value);
}

export interface ClickRegion {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    modal?: boolean;
    action(): void;
}

export class ClickableRegionRegistry {
    private readonly regions = new Map<string, ClickRegion>();
    private modalActive = false;

    register(region: ClickRegion): () => void {
        this.regions.set(region.id, region);
        return () => {
            if (this.regions.get(region.id) === region) this.regions.delete(region.id);
        };
    }

    clear(): void {
        this.regions.clear();
    }

    setModalActive(active: boolean): void {
        this.modalActive = active;
    }

    dispatch(click: MouseClick): boolean {
        const regions = [...this.regions.values()].filter((candidate) => Boolean(candidate.modal) === this.modalActive).reverse();
        const region = regions.find((candidate) =>
            click.x >= candidate.x && click.y >= candidate.y &&
            click.x < candidate.x + candidate.width && click.y < candidate.y + candidate.height,
        );
        region?.action();
        return Boolean(region);
    }
}

export class SgrMouseParser {
    private buffer = "";

    feed(chunk: Uint8Array | string): MouseClick[] {
        this.buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
        const clicks: MouseClick[] = [];
        while (this.buffer.length) {
            const start = this.buffer.indexOf("\u001b[<");
            if (start < 0) {
                this.buffer = this.buffer.endsWith("\u001b") || this.buffer.endsWith("\u001b[") || this.buffer.endsWith("\u001b[<")
                    ? this.buffer.slice(-3)
                    : "";
                break;
            }
            if (start > 0) this.buffer = this.buffer.slice(start);
            const match = this.buffer.match(/^\u001b\[<(\d+);(\d+);(\d+)([Mm])/);
            if (!match) {
                if (this.buffer.length > 96 || /[^\u001b\[<\d;]/.test(this.buffer.slice(3))) {
                    this.buffer = this.buffer.slice(1);
                    continue;
                }
                break;
            }
            this.buffer = this.buffer.slice(match[0].length);
            const code = Number(match[1]);
            const x = Number(match[2]);
            const y = Number(match[3]);
            if (match[4] === "M" && Number.isSafeInteger(code) && (code & 3) === 0 && (code & 32) === 0 && (code & 64) === 0 && x >= 1 && y >= 1) {
                clicks.push({ x: x - 1, y: y - 1, button: "left" });
            }
        }
        return clicks;
    }
}

export interface MouseOutputStream {
    isTTY?: boolean;
    write(value: string): unknown;
}

/** Owns only the terminal mouse mode and the small SGR click parser. */
export class TerminalMouseSession {
    private readonly parser = new SgrMouseParser();
    private readonly listeners = new Set<(click: MouseClick) => void>();
    private active = false;

    constructor(
        private readonly output: MouseOutputStream = process.stdout,
    ) {}

    subscribe(listener: (click: MouseClick) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    enter(): boolean {
        if (this.active) return true;
        if (!this.output.isTTY) return false;
        try {
            this.output.write("\u001b[?1000h\u001b[?1006h");
            this.active = true;
            return true;
        } catch {
            try { this.output.write("\u001b[?1006l\u001b[?1000l"); } catch { /* Best-effort rollback of a partial mode change. */ }
            return false;
        }
    }

    handleInput(input: string): boolean {
        if (!this.active || !isSgrMouseSequence(input)) return false;
        const sequence = input.startsWith("\u001b") ? input : `\u001b${input}`;
        for (const click of this.parser.feed(sequence)) {
            for (const listener of this.listeners) {
                try { listener(click); } catch { /* A click consumer cannot break terminal input. */ }
            }
        }
        return true;
    }

    leave(): void {
        if (!this.active) return;
        this.active = false;
        try { this.output.write("\u001b[?1006l\u001b[?1000l"); }
        catch { /* Continue cleanup even if the terminal output has closed. */ }
    }
}
