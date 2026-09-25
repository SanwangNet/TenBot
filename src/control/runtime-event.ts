import type { ProviderErrorNotice } from "./provider-error.js";
import type { ConversationRuntimeEvent } from "./conversation-timeline.js";

export type RuntimeEvent =
    | { type: "provider-error"; notice: ProviderErrorNotice }
    | { type: "recent-peers-updated" }
    | { type: "reload-failure"; target: "config" | "prompt" | "memes"; message: string; timestamp: string }
    | ConversationRuntimeEvent;

export type RuntimeEventListener = (event: RuntimeEvent) => void;
