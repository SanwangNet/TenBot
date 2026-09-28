import { useEffect, useReducer } from "react";
import { apiClient, ApiError, setUnauthorizedHandler } from "../api/client.js";
import { RuntimeProvider } from "../runtime/runtime-context.js";
import { App } from "../App.js";
import { AuthGateView, authGateReducer, initialAuthGateState } from "./auth-view.js";

export function AuthGate() {
    const [state, dispatch] = useReducer(authGateReducer, initialAuthGateState);
    useEffect(() => {
        const controller = new AbortController();
        const onUnauthorized = () => dispatch({ type: "unauthenticated" });
        setUnauthorizedHandler(onUnauthorized);
        void apiClient.getAuthMe(controller.signal)
            .then((result) => dispatch({ type: "authenticated", user: result.user }))
            .catch((cause: unknown) => {
                if (controller.signal.aborted) return;
                if (cause instanceof ApiError && cause.status === 401) {
                    dispatch({ type: "unauthenticated" });
                    return;
                }
                dispatch({
                    type: "unavailable",
                    message: cause instanceof ApiError && cause.status === 503
                        ? "服务器尚未配置有效的 GitHub OAuth。请检查服务端环境变量。"
                        : "无法连接认证服务，请稍后重试。",
                });
            });
        return () => {
            controller.abort();
            setUnauthorizedHandler(undefined);
        };
    }, []);

    return <AuthGateView state={state}>
        {state.kind === "authenticated" && <RuntimeProvider><App user={state.user} onLogout={() => dispatch({ type: "unauthenticated" })} /></RuntimeProvider>}
    </AuthGateView>;
}
