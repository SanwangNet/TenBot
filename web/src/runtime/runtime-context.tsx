import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, type ReactNode } from "react";
import { apiClient } from "../api/client.js";
import { connectRuntimeEvents } from "../api/events.js";
import type { PublicConfig } from "../api/types.js";
import { initialRuntimeState, runtimeReducer, type RuntimeState } from "./runtime-state.js";
import { initialLogViewState, logViewReducer, type LogViewAction, type LogViewState } from "../components/log-state.js";

interface RuntimeContextValue extends RuntimeState {
    acceptConfig(config: PublicConfig): void;
}

interface LogContextValue {
    state: LogViewState;
    dispatch(action: LogViewAction): void;
}

const RuntimeContext = createContext<RuntimeContextValue | null>(null);
const LogContext = createContext<LogContextValue | null>(null);

export function RuntimeProvider({ children }: { children: ReactNode }) {
    const [state, dispatch] = useReducer(runtimeReducer, initialRuntimeState);
    const [logState, dispatchLog] = useReducer(logViewReducer, initialLogViewState);

    const acceptConfig = useCallback((config: PublicConfig) => dispatch({ type: "config-refresh", config }), []);
    useEffect(() => {
        const controller = new AbortController();
        const closeEvents = connectRuntimeEvents({
            onStatus: (status) => dispatch({ type: "status", status }),
            onLog: (entry) => dispatchLog({ type: "append", entry }),
            onRuntimeEvent: (event) => dispatch({ type: "runtime-event", event, receivedAt: new Date().toISOString() }),
            onConnection: (connection) => dispatch({ type: "connection", connection }),
        });

        void Promise.all([
            apiClient.getStatus(controller.signal),
            apiClient.getConfig(controller.signal),
        ]).then(([status, config]) => dispatch({ type: "bootstrap-success", status, config }))
            .catch(() => {
                if (!controller.signal.aborted) {
                    dispatch({ type: "bootstrap-failure", message: "无法连接 TenBot Runtime" });
                }
            });

        return () => {
            controller.abort();
            closeEvents();
        };
    }, []);

    const configRevision = state.status?.hotReload?.revision;
    useEffect(() => {
        if (configRevision === undefined) return;
        const controller = new AbortController();
        void apiClient.getConfig(controller.signal)
            .then((config) => dispatch({ type: "config-refresh", config }))
            .catch(() => undefined);
        return () => controller.abort();
    }, [configRevision]);

    const runtimeValue = useMemo<RuntimeContextValue>(() => ({ ...state, acceptConfig }), [state, acceptConfig]);
    const logValue = useMemo<LogContextValue>(() => ({ state: logState, dispatch: dispatchLog }), [logState]);
    return <RuntimeContext.Provider value={runtimeValue}>
        <LogContext.Provider value={logValue}>{children}</LogContext.Provider>
    </RuntimeContext.Provider>;
}

export function useRuntime() {
    const context = useContext(RuntimeContext);
    if (!context) throw new Error("useRuntime must be used within RuntimeProvider");
    return context;
}

export function useLogs() {
    const context = useContext(LogContext);
    if (!context) throw new Error("useLogs must be used within RuntimeProvider");
    return context;
}
