import type { AiResult } from "./reply-result.js";

export type ModelResult = AiResult;

export interface ModelCapabilities {
    webSearch: boolean;
}

export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh";
export type ModelVerbosity = "low" | "medium" | "high";

export interface ModelToolDefinition {
    type: "function";
    name: string;
    description: string;
    strict?: boolean;
    parameters: Record<string, unknown>;
}

export interface ModelToolCall {
    name: string;
    arguments: string;
}

export type ModelToolExecution =
    | { kind: "result"; result: ModelResult }
    | { kind: "continue"; output: string }
    | { kind: "ignore" };

/** The Runtime prepares the semantic input and owns the business-tool handlers. */
export interface ModelRequest {
    input: string;
    /** Immutable provider prompt captured when this Attempt starts. */
    systemPrompt: string;
    imageUrls?: readonly string[];
    tools: readonly ModelToolDefinition[];
    executeTool(call: ModelToolCall): Promise<ModelToolExecution>;
}

export type ModelEvent =
    | { type: "streamStarted"; elapsedMs: number }
    | { type: "webSearchStarted" };

export interface ModelGenerateOptions {
    signal: AbortSignal;
    onEvent?: (event: ModelEvent) => void | Promise<void>;
}

export interface ModelPlugin {
    readonly id: string;
    readonly model: string;
    readonly capabilities: Readonly<ModelCapabilities>;
    /** Read-only provider metadata for control surfaces; it does not change generate(). */
    readonly reasoningEffort?: ReasoningEffort;
    readonly verbosity?: ModelVerbosity;
    generate(request: ModelRequest, options: ModelGenerateOptions): Promise<ModelResult>;
}

export class ModelAbortedError extends Error {
    constructor(message = "Model request aborted") {
        super(message);
        this.name = "ModelAbortedError";
    }
}

export class ModelProviderError extends Error {
    readonly status?: number;
    readonly code?: string;
    readonly retryable?: boolean;

    constructor(provider: string, cause: unknown) {
        super(`${provider} provider request failed`, { cause });
        this.name = "ModelProviderError";
        const fields = cause && typeof cause === "object" ? cause as Record<string, unknown> : undefined;
        if (typeof fields?.status === "number") this.status = fields.status;
        if (typeof fields?.code === "string") this.code = fields.code;
        if (fields?.retryable === true) this.retryable = true;
    }
}
