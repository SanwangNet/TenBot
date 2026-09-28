import React, { type ReactNode } from "react";
import type { AuthMeResponse } from "../api/types.js";

export type AuthGateState =
    | { kind: "loading" }
    | { kind: "unauthenticated" }
    | { kind: "unavailable"; message: string }
    | { kind: "authenticated"; user: AuthMeResponse["user"] };

type AuthGateAction =
    | { type: "authenticated"; user: AuthMeResponse["user"] }
    | { type: "unauthenticated" }
    | { type: "unavailable"; message: string };

export const initialAuthGateState: AuthGateState = { kind: "loading" };

export function authGateReducer(_state: AuthGateState, action: AuthGateAction): AuthGateState {
    if (action.type === "authenticated") return { kind: "authenticated", user: action.user };
    if (action.type === "unavailable") return { kind: "unavailable", message: action.message };
    return { kind: "unauthenticated" };
}

export function AuthGateView({ state, children }: { state: AuthGateState; children?: ReactNode }) {
    if (state.kind === "loading") return <React.Fragment><main className="auth-screen"><section className="auth-card" aria-live="polite"><span className="brand-mark">T</span><p>正在验证 TenBot 登录状态…</p></section></main></React.Fragment>;
    if (state.kind === "authenticated") return children;
    return <LoginScreen unavailable={state.kind === "unavailable" ? state.message : undefined} />;
}

function LoginScreen({ unavailable }: { unavailable?: string }) {
    return <React.Fragment><main className="auth-screen">
        <section className="auth-card">
            <div className="auth-brand"><span className="brand-mark" aria-hidden="true">T</span><span>TenBot</span></div>
            <div className="auth-kicker">WEB CONTROL PLANE</div>
            <h1>{unavailable ? "管理后台暂不可用" : "安全登录"}</h1>
            <p>{unavailable ?? "使用已获授权的 GitHub 账号继续。只有管理员 allowlist 中的账号可以访问控制台。"}</p>
            {unavailable
                ? <div className="auth-error" role="alert">{unavailable}</div>
                : <a className="github-login" href="/api/auth/github"><GitHubMark />使用 GitHub 登录</a>}
            <div className="auth-footnote">TenBot 管理访问由 GitHub numeric user ID 授权</div>
        </section>
    </main></React.Fragment>;
}

function GitHubMark() {
    return <svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 .8a11.2 11.2 0 0 0-3.54 21.83c.56.1.76-.24.76-.54v-2.1c-3.1.67-3.76-1.32-3.76-1.32-.5-1.28-1.24-1.62-1.24-1.62-1.01-.69.08-.68.08-.68 1.12.08 1.71 1.15 1.71 1.15.99 1.7 2.6 1.21 3.23.92.1-.72.39-1.21.7-1.49-2.48-.28-5.09-1.24-5.09-5.52 0-1.22.44-2.22 1.15-3-.12-.28-.5-1.42.11-2.96 0 0 .94-.3 3.08 1.15a10.7 10.7 0 0 1 5.6 0c2.14-1.45 3.08-1.15 3.08-1.15.61 1.54.23 2.68.11 2.96.72.78 1.15 1.78 1.15 3 0 4.29-2.61 5.23-5.1 5.51.4.35.75 1.03.75 2.08v3.07c0 .3.2.65.77.54A11.2 11.2 0 0 0 12 .8Z" /></svg>;
}
