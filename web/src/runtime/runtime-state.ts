import type { PublicConfig, RuntimeEvent, RuntimeStatus } from "../api/types.js";
import type { RuntimeConnectionState } from "../api/events.js";

export interface RuntimeState {
    status: RuntimeStatus | null;
    config: PublicConfig | null;
    connection: RuntimeConnectionState;
    loading: boolean;
    error: string | null;
    lastRuntimeEventAt: string | null;
}

export const initialRuntimeState: RuntimeState = {
    status: null,
    config: null,
    connection: "connecting",
    loading: true,
    error: null,
    lastRuntimeEventAt: null,
};

export type RuntimeAction =
    | { type: "bootstrap-success"; status: RuntimeStatus; config: PublicConfig }
    | { type: "bootstrap-failure"; message: string }
    | { type: "status"; status: RuntimeStatus }
    | { type: "connection"; connection: RuntimeConnectionState }
    | { type: "runtime-event"; event: RuntimeEvent; receivedAt: string };

export function runtimeReducer(state: RuntimeState, action: RuntimeAction): RuntimeState {
    switch (action.type) {
        case "bootstrap-success":
            return {
                ...state,
                status: state.status ?? action.status,
                config: state.config ?? action.config,
                loading: false,
                error: null,
            };
        case "bootstrap-failure":
            return { ...state, loading: false, error: action.message };
        case "status":
            return { ...state, status: action.status, loading: false, error: null };
        case "connection":
            return { ...state, connection: action.connection };
        case "runtime-event":
            return { ...state, lastRuntimeEventAt: action.receivedAt };
        default:
            return state;
    }
}
