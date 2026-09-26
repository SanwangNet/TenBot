import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useState, type ReactNode } from "react";
import { apiClient } from "../api/client.js";
import { connectRuntimeEvents } from "../api/events.js";
import type { PublicConfig } from "../api/types.js";
import { initialRuntimeState, runtimeReducer, type RuntimeState } from "./runtime-state.js";
import { initialLogViewState, logViewReducer, type LogViewAction, type LogViewState } from "../components/log-state.js";
import { conversationReducer, initialConversationViewState, type ConversationAction, type ConversationViewState } from "../conversations/conversation-state.js";
import { useFeedback } from "../ui/feedback.js";
import { isProminentProviderError } from "../ui/feedback-state.js";

interface RuntimeContextValue extends RuntimeState {
    acceptConfig(config: PublicConfig): void;
}

interface LogContextValue {
    state: LogViewState;
    dispatch(action: LogViewAction): void;
}

const RuntimeContext = createContext<RuntimeContextValue | null>(null);
const LogContext = createContext<LogContextValue | null>(null);
const ConversationContext = createContext<{ state: ConversationViewState; dispatch(action: ConversationAction): void } | null>(null);
const PeerRevisionContext = createContext(0);
const LastRuntimeEventContext = createContext<string | null>(null);

export function RuntimeProvider({ children }: { children: ReactNode }) {
    const [state, dispatch] = useReducer(runtimeReducer, initialRuntimeState);
    const [logState, dispatchLog] = useReducer(logViewReducer, initialLogViewState);
    const [conversationState, dispatchConversation] = useReducer(conversationReducer, initialConversationViewState);
    const [peerRevision, advancePeerRevision] = useReducer((value: number) => value + 1, 0);
    const [lastRuntimeEventAt, setLastRuntimeEventAt] = useState<string | null>(null);
    const { notify } = useFeedback();

    const acceptConfig = useCallback((config: PublicConfig) => dispatch({ type: "config-refresh", config }), []);
    useEffect(() => {
        const controller = new AbortController();
        const closeEvents = connectRuntimeEvents({
            onStatus: (status) => dispatch({ type: "status", status }),
            onLog: (entry) => dispatchLog({ type: "append", entry }),
            onRuntimeEvent: (event) => {
                setLastRuntimeEventAt(new Date().toISOString());
                if (event.type === "conversation-item") dispatchConversation({ type: "event", event });
                if (event.type === "recent-peers-updated") advancePeerRevision();
                if (event.type === "provider-error" && isProminentProviderError(event.notice)) notify("error", `${event.notice.provider}: ${event.notice.message}`, event.notice);
                if (event.type === "reload-failure") notify("warning", event.message);
            },
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
    }, [notify]);

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
    const conversationValue = useMemo(() => ({ state: conversationState, dispatch: dispatchConversation }), [conversationState]);
    return <RuntimeContext.Provider value={runtimeValue}>
        <LogContext.Provider value={logValue}><ConversationContext.Provider value={conversationValue}><PeerRevisionContext.Provider value={peerRevision}><LastRuntimeEventContext.Provider value={lastRuntimeEventAt}>{children}</LastRuntimeEventContext.Provider></PeerRevisionContext.Provider></ConversationContext.Provider></LogContext.Provider>
    </RuntimeContext.Provider>;
}

export function useConversations() {
    const context = useContext(ConversationContext);
    if (!context) throw new Error("useConversations must be used within RuntimeProvider");
    return context;
}

export function usePeerRevision() { return useContext(PeerRevisionContext); }
export function useLastRuntimeEventAt() { return useContext(LastRuntimeEventContext); }

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
