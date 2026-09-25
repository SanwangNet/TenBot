import React from "react";
import { render, useInput } from "ink";
import { createTenBotRuntime, type TenBotRuntime } from "../runtime.js";
import { StartupFailure, TenBotTui } from "./app.js";

function StartupFailureScreen({ message, onQuit }: { message: string; onQuit(): void }) {
    useInput((input, key) => {
        if (input === "q" || (key.ctrl && input.toLowerCase() === "c")) onQuit();
    });
    return <StartupFailure message={message} />;
}

async function main(): Promise<void> {
    let runtime: TenBotRuntime;
    try {
        runtime = await createTenBotRuntime({ consoleLogs: false });
    } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown startup error";
        let instance: ReturnType<typeof render> | undefined;
        instance = render(<StartupFailureScreen message={message} onQuit={() => instance?.unmount()} />, {
            exitOnCtrlC: false,
        });
        await instance.waitUntilExit();
        return;
    }

    let instance: ReturnType<typeof render> | undefined;
    let quitting = false;
    const gracefulQuit = async () => {
        if (quitting) return;
        quitting = true;
        try { await runtime.control.shutdown(); }
        catch { /* The screen still needs to be released after shutdown reports an error. */ }
        finally { instance?.unmount(); }
    };

    instance = render(<TenBotTui control={runtime.control} onQuit={() => instance?.unmount()} />, {
        exitOnCtrlC: false,
    });
    const onSigint = () => { void gracefulQuit(); };
    process.once("SIGINT", onSigint);
    void runtime.start().catch(() => undefined);
    try {
        await instance.waitUntilExit();
    } finally {
        process.off("SIGINT", onSigint);
    }
}

await main();
