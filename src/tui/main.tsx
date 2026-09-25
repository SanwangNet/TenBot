import React from "react";
import { render, useInput } from "ink";
import { createTenBotRuntime, type TenBotRuntime } from "../runtime.js";
import { StartupFailure, TenBotTui } from "./app.js";
import { supportsInteractiveTui } from "./terminal-check.js";

function StartupFailureScreen({ message, onQuit }: { message: string; onQuit(): void }) {
    useInput((input, key) => {
        if (input === "q" || (key.ctrl && input.toLowerCase() === "c")) onQuit();
    });
    return <StartupFailure message={message} />;
}

async function main(): Promise<void> {
    if (!supportsInteractiveTui()) {
        console.error("当前终端不支持交互式 TUI，请使用普通终端或运行 pnpm dev。");
        return;
    }

    let runtime: TenBotRuntime;
    try {
        runtime = await createTenBotRuntime({ consoleLogs: false });
    } catch (error) {
        const message = error instanceof Error ? error.message : "未知启动异常";
        let instance: ReturnType<typeof render> | undefined;
        instance = render(<StartupFailureScreen message={message} onQuit={() => instance?.unmount()} />, {
            exitOnCtrlC: false,
            alternateScreen: true,
        });
        try { await instance.waitUntilExit(); }
        finally { instance.unmount(); }
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

    instance = render(<TenBotTui control={runtime.control} onQuit={gracefulQuit} />, {
        exitOnCtrlC: false,
        alternateScreen: true,
    });
    const onSigint = () => { void gracefulQuit(); };
    process.once("SIGINT", onSigint);
    void runtime.start().catch(() => gracefulQuit());
    try {
        await instance.waitUntilExit();
    } finally {
        process.off("SIGINT", onSigint);
        if (!quitting) await gracefulQuit();
    }
}

await main();
