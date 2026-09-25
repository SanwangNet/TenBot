export interface TerminalOutputWriter {
    write(value: string, callback?: (error?: Error | null) => void): unknown;
}

/** Flush terminal cleanup bytes, then let the foreground TUI process exit. */
export async function exitTuiProcess(
    output: TerminalOutputWriter = process.stdout,
    exit: (code: number) => void = (code) => process.exit(code),
): Promise<void> {
    await new Promise<void>((resolve) => {
        try { output.write("", () => resolve()); }
        catch { resolve(); }
    });
    exit(0);
}
