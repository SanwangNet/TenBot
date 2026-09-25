import type { ProviderErrorNotice } from "./provider-error.js";

export type RuntimeEvent =
    | { type: "provider-error"; notice: ProviderErrorNotice }
    | { type: "recent-peers-updated" };

export type RuntimeEventListener = (event: RuntimeEvent) => void;
