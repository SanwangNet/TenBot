import { createContext, useContext, useEffect, useMemo, useReducer, type ReactNode } from "react";
import { apiClient } from "../api/client.js";
import { connectRuntimeEvents } from "../api/events.js";
import { initialRuntimeState, runtimeReducer } from "./runtime-state.js";

const RuntimeContext = createContext<ReturnType<typeof useRuntimeValue> | null>(null);

function useRuntimeValue() {
    const [state, dispatch] = useReducer(runtimeReducer, initialRuntimeState);

    useEffect(() => {
        const controller = new AbortController();
        const closeEvents = connectRuntimeEvents({
            onStatus: (status) => dispatch({ type: "status", status }),
            onLog: () => undefined,
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

    return useMemo(() => ({ ...state }), [state]);
}

export function RuntimeProvider({ children }: { children: ReactNode }) {
    const value = useRuntimeValue();
    return <RuntimeContext.Provider value={value}>{children}</RuntimeContext.Provider>;
}

export function useRuntime() {
    const context = useContext(RuntimeContext);
    if (!context) throw new Error("useRuntime must be used within RuntimeProvider");
    return context;
}
