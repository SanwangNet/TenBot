import type { ProviderErrorNotice } from "./provider-error.js";

export type RuntimeEvent = {
    type: "provider-error";
    notice: ProviderErrorNotice;
};

export type RuntimeEventListener = (event: RuntimeEvent) => void;
