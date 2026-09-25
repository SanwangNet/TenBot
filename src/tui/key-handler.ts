import type { TenBotControl } from "../control/tenbot-control.js";

export interface TuiKey {
    ctrl?: boolean;
}

export async function handleTuiKey(
    input: string,
    key: TuiKey,
    control: TenBotControl,
    report: (message: string) => void,
    quit: () => void,
): Promise<void> {
    if (input === "q" || (key.ctrl && input.toLowerCase() === "c")) {
        try { await control.shutdown(); }
        catch { report("Shutdown reported an error"); }
        finally { quit(); }
        return;
    }
    try {
        if (input === "p") {
            const result = await control.reloadPrompt();
            report(result.message);
        } else if (input === "m") {
            const result = await control.reloadMemes();
            report(result.message);
        } else if (input === "r") {
            const [prompt, memes] = await Promise.all([control.reloadPrompt(), control.reloadMemes()]);
            report(prompt.ok && memes.ok ? "Runtime data reloaded" : "One reload failed; its previous data was kept");
        }
    } catch {
        report("Reload failed; previous data kept");
    }
}
