import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createViteServer } from "vite";
import { ApiError, apiClient, parseJsonResponse, setUnauthorizedHandler } from "../web/src/api/client.js";
import { parseEventData } from "../web/src/api/events.js";
import type { PublicConfig, RuntimeStatus } from "../web/src/api/types.js";
import { initialRuntimeState, runtimeReducer } from "../web/src/runtime/runtime-state.js";
import {
    createSettingsForm,
    dirtySettingsFields,
    visibleDirtySettingsFields,
    parseTimeoutInput,
    parseTurnWaitSecondsInput,
    settingsFormReducer,
    settingsFieldError,
    settingsPatches,
    saveSettingsChanges,
} from "../web/src/settings/settings-state.js";
import { filterLogs, initialLogViewState, isLogLevelFilter, loadLogLevelFilter, logViewReducer, LOG_LEVEL_FILTER_STORAGE_KEY, MAX_WEB_LOG_ENTRIES, saveLogLevelFilter } from "../web/src/components/log-state.js";
import { LogRows } from "../web/src/components/logs-page.js";
import { MemberRow, MEMBERS_EVIDENCE_REFRESH_INTERVAL_MS, MEMBERS_PAGE_TITLE, MEMBERS_ROOT_SECTION_TITLES } from "../web/src/components/members-page.js";
import type { GroupMemberSummary, LogEntry } from "../web/src/api/types.js";
import { conversationReducer, initialConversationViewState } from "../web/src/conversations/conversation-state.js";
import { addNotice, isProminentProviderError } from "../web/src/ui/feedback-state.js";
import { createEditorDraft, editDraft, isEditorDirty } from "../web/src/editor/editor-state.js";
import { nextPage } from "../web/src/navigation.js";
import { appRouteHash, parseAppRoute } from "../web/src/navigation.js";
import { SettingsNavigation, SETTINGS_PAGES } from "../web/src/settings/settings-navigation.js";
import { dirtySettingsFieldsForSection, SETTINGS_SECTION_FIELDS } from "../web/src/settings/settings-state.js";
import { ModelSettings } from "../web/src/settings/pages/model-settings.js";
import { JudgeSettings } from "../web/src/settings/pages/judge-settings.js";
import { RuntimeSettings } from "../web/src/settings/pages/runtime-settings.js";
import { ImageSettings } from "../web/src/settings/pages/image-settings.js";
import { AuthGateView, authGateReducer, initialAuthGateState, type AuthGateState } from "../web/src/auth/auth-view.js";
import { classifyGptModel, getGptModelPickerEntries } from "../src/ai/model-classification.js";

const status: RuntimeStatus = {
    qq: "connected",
    groupRepliesEnabled: true,
    provider: { id: "gpt", model: "gpt-test", webSearch: true, configured: true },
    activeCycles: 1,
    contextConversations: 3,
    hotReload: {
        enabled: true,
        revision: 4,
        loadedAt: "2026-01-01T00:00:00.000Z",
        lastSuccessAt: "2026-01-01T00:00:00.000Z",
        requiresRestart: false,
    },
    memes: { count: 12, revision: 2, loadedAt: "2026-01-01T00:00:00.000Z" },
    prompt: { provider: "gpt", revision: 3, loadedAt: "2026-01-01T00:00:00.000Z", characters: 100, lines: 8 },
    shuttingDown: false,
};

const config: PublicConfig = {
    aiProvider: "gpt",
    image: { enabled: false, provider: "gpt", model: "", quality: "low", size: "1024x1024", outputFormat: "png" },
    memeSendMaxEdge: 160,
    replyJudge: { model: "judge", timeoutMs: 5000, fallbackToMainOnInvalidOutput: true, turnWaitMs: 20_000 },
    gpt: { model: "gpt-test", reasoningEffort: "high", verbosity: "high", configured: true },
    deepseek: { model: "deepseek-test", reasoningEffort: "high", configured: false },
    botLoopGuard: { maxCycles: 4 },
};

test("API JSON response parser returns successful payloads and reports safe HTTP or JSON errors", () => {
    assert.deepEqual(parseJsonResponse<{ ok: boolean }>(200, "{\"ok\":true}"), { ok: true });
    assert.throws(() => parseJsonResponse(404, "{\"error\":{\"message\":\"Not found\"}}"), (error: unknown) =>
        error instanceof ApiError && error.status === 404 && error.message === "Not found");
    assert.throws(() => parseJsonResponse(200, "not json"), /无效 JSON/);
});

test("GPT and image pickers filter by category while retaining a saved filtered model", () => {
    const catalog = [
        classifyGptModel("gpt-6"),
        classifyGptModel("gpt-image-2"),
        classifyGptModel("gpt-context-compaction"),
        classifyGptModel("vendor-new-model"),
    ];
    const chatPicker = getGptModelPickerEntries(catalog, "chat", "gpt-context-compaction");
    assert.deepEqual(chatPicker.recommended.map(({ id }) => id), ["gpt-6"]);
    assert.equal(chatPicker.preservedCurrent?.id, "gpt-context-compaction");
    assert.equal(chatPicker.currentIsListed, true);

    const imagePicker = getGptModelPickerEntries(catalog, "image", "gpt-6");
    assert.deepEqual(imagePicker.recommended.map(({ id }) => id), ["gpt-image-2"]);
    assert.equal(imagePicker.preservedCurrent?.id, "gpt-6");
    assert.equal(getGptModelPickerEntries(catalog, "chat", "vendor-custom-model").currentIsListed, false);
    assert.deepEqual(getGptModelPickerEntries(catalog, "chat", "gpt-context-compaction", true).recommended.map(({ id }) => id), catalog.map(({ id }) => id));
});

test("auth gate renders the GitHub login screen when unauthenticated and the existing app when authenticated", () => {
    const login = renderToStaticMarkup(createElement(AuthGateView, { state: { kind: "unauthenticated" } }, createElement("main", null, "Dashboard")));
    assert.match(login, /TenBot/);
    assert.match(login, /使用 GitHub 登录/);
    assert.match(login, /href="\/api\/auth\/github"/);
    assert.doesNotMatch(login, /Dashboard|password|用户名/);

    const user = { id: "12345678", login: "admin", avatarUrl: null };
    const authenticated = authGateReducer(initialAuthGateState, { type: "authenticated", user });
    const dashboard = renderToStaticMarkup(createElement(AuthGateView, { state: authenticated }, createElement("main", null, "Existing Dashboard")));
    assert.match(dashboard, /Existing Dashboard/);
    assert.doesNotMatch(dashboard, /使用 GitHub 登录/);
});

test("API 401 notifies auth gate and logout calls the server before returning to the login view", async () => {
    const originalFetch = globalThis.fetch;
    let unauthorizedCalls = 0;
    let authState: AuthGateState = { kind: "authenticated", user: { id: "12345678", login: "admin", avatarUrl: null } };
    setUnauthorizedHandler(() => {
        unauthorizedCalls++;
        authState = authGateReducer(authState, { type: "unauthenticated" });
    });
    globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: "Authentication required" } }), {
        status: 401, headers: { "Content-Type": "application/json" },
    });
    try {
        await assert.rejects(apiClient.getStatus(), (error: unknown) => error instanceof ApiError && error.status === 401);
        assert.equal(unauthorizedCalls, 1);
        assert.equal(authState.kind, "unauthenticated");
        assert.match(renderToStaticMarkup(createElement(AuthGateView, { state: authState })), /使用 GitHub 登录/);

        let logoutPath = "";
        let logoutMethod = "";
        globalThis.fetch = async (input, init) => {
            logoutPath = String(input);
            logoutMethod = init?.method ?? "";
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
        };
        assert.deepEqual(await apiClient.logout(), { ok: true });
        assert.equal(logoutPath, "/api/auth/logout");
        assert.equal(logoutMethod, "POST");
        const loggedOut = authGateReducer(authState, { type: "unauthenticated" });
        const markup = renderToStaticMarkup(createElement(AuthGateView, { state: loggedOut }));
        assert.match(markup, /使用 GitHub 登录/);
    } finally {
        globalThis.fetch = originalFetch;
        setUnauthorizedHandler(undefined);
    }
});

test("SSE message parser decodes JSON and rejects malformed frames", () => {
    assert.deepEqual(parseEventData<{ activeCycles: number }>("{\"activeCycles\":2}"), { activeCycles: 2 });
    assert.throws(() => parseEventData("{"), SyntaxError);
});

test("Runtime reducer preserves live status over bootstrap and tracks connection and event time", () => {
    const liveStatus = { ...status, activeCycles: 2 };
    const withLiveStatus = runtimeReducer(initialRuntimeState, { type: "status", status: liveStatus });
    const bootstrapped = runtimeReducer(withLiveStatus, { type: "bootstrap-success", status, config });
    assert.equal(bootstrapped.status?.activeCycles, 2);
    assert.equal(bootstrapped.config, config);
    assert.equal(bootstrapped.loading, false);

    const online = runtimeReducer(bootstrapped, { type: "connection", connection: "online" });
    const recent = runtimeReducer(online, {
        type: "runtime-event",
        event: { type: "members-updated" },
        receivedAt: "2026-03-01T12:00:00.000Z",
    });
    assert.equal(recent.connection, "online");
    assert.equal(recent.lastRuntimeEventAt, "2026-03-01T12:00:00.000Z");
});

test("settings form calculates dirty fields and serializable patches with numeric conversion", () => {
    let form = createSettingsForm(config);
    assert.equal("logLevel" in form.values, false);
    assert.equal("botTimeZone" in form.values, false);
    form = settingsFormReducer(form, { type: "edit", field: "replyJudge.timeoutMs", value: "15000" })!;
    form = settingsFormReducer(form, { type: "edit", field: "aiProvider", value: "deepseek" })!;
    assert.deepEqual(dirtySettingsFields(form), ["aiProvider", "replyJudge.timeoutMs"]);
    assert.deepEqual(settingsPatches(form), [
        { field: "aiProvider", value: "deepseek" },
        { field: "replyJudge.timeoutMs", value: 15000 },
    ]);
    assert.equal(parseTimeoutInput("15000"), 15000);
    assert.equal(parseTimeoutInput("999"), null);
    assert.equal(parseTimeoutInput("1500.5"), null);
});

test("Members root replaces legacy peer categories and exposes full group-scoped member IDs", () => {
    assert.equal(MEMBERS_PAGE_TITLE, "成员");
    assert.equal(MEMBERS_ROOT_SECTION_TITLES.markedBots, "已标记的机器人账号");
    assert.equal(MEMBERS_ROOT_SECTION_TITLES.groups, "群聊");
    assert.equal("recent" in MEMBERS_ROOT_SECTION_TITLES, false);
    assert.equal(MEMBERS_EVIDENCE_REFRESH_INTERVAL_MS, 60_000);

    const member: GroupMemberSummary = {
        groupOpenid: "group-test", memberOpenid: "complete-member-openid", username: "Winter",
        firstSeenAt: 1, lastSeenAt: 2, updatedAt: 2, platformBot: false, manualBot: true,
        autoBot: false, detectionMarks: 2, lastDetectionAt: 2,
    };
    const row = renderToStaticMarkup(createElement(MemberRow, { member, groupLabel: "测试群", onDetails() {} }));
    assert.match(row, /complete-member-openid/);
    assert.match(row, /手动标记/);
    assert.match(row, /疑似行为 2 次/);
    assert.doesNotMatch(row, /自动识别/);

    for (const [marks, expected, tone] of [
        [0, /普通成员/, "ordinary"],
        [1, /疑似行为 1 次/, "yellow"],
        [3, /疑似行为 3 次/, "orange"],
        [5, /建议人工确认/, "orange"],
    ] as const) {
        const markup = renderToStaticMarkup(createElement(MemberRow, {
            member: { ...member, manualBot: false, detectionMarks: marks }, groupLabel: "群聊", onDetails() {},
        }));
        assert.match(markup, expected);
        assert.match(markup, new RegExp(`member-detection-count ${tone}`));
    }
});

test("meme send size setting supports original size and custom values", () => {
    let form = createSettingsForm(config);
    assert.equal(form.values.memeSendMaxEdge, "160");
    form = settingsFormReducer(form, { type: "edit", field: "memeSendMaxEdge", value: "original" })!;
    assert.deepEqual(settingsPatches(form), [{ field: "memeSendMaxEdge", value: null }]);
    form = settingsFormReducer(form, { type: "edit", field: "memeSendMaxEdge", value: "512" })!;
    assert.deepEqual(settingsPatches(form), [{ field: "memeSendMaxEdge", value: 512 }]);
});

test("settings fallback toggle starts from server config, produces one boolean patch, and cleans after save", () => {
    let form = createSettingsForm(config);
    assert.equal(form.values["replyJudge.fallbackToMainOnInvalidOutput"], true);
    form = settingsFormReducer(form, { type: "edit", field: "replyJudge.fallbackToMainOnInvalidOutput", value: false })!;
    assert.deepEqual(dirtySettingsFields(form), ["replyJudge.fallbackToMainOnInvalidOutput"]);
    assert.deepEqual(settingsPatches(form), [{ field: "replyJudge.fallbackToMainOnInvalidOutput", value: false }]);

    const savedConfig: PublicConfig = {
        ...config,
        replyJudge: { ...config.replyJudge, fallbackToMainOnInvalidOutput: false },
    };
    form = settingsFormReducer(form, { type: "saved", config: savedConfig, field: "replyJudge.fallbackToMainOnInvalidOutput" })!;
    assert.equal(form.values["replyJudge.fallbackToMainOnInvalidOutput"], false);
    assert.deepEqual(dirtySettingsFields(form), []);
});

test("settings turn wait is edited in seconds and saved as validated milliseconds", () => {
    let form = createSettingsForm(config);
    assert.equal(form.values["replyJudge.turnWaitMs"], "20");
    form = settingsFormReducer(form, { type: "edit", field: "replyJudge.turnWaitMs", value: "12.5" })!;
    assert.deepEqual(dirtySettingsFields(form), ["replyJudge.turnWaitMs"]);
    assert.deepEqual(settingsPatches(form), [{ field: "replyJudge.turnWaitMs", value: 12_500 }]);
    assert.equal(parseTurnWaitSecondsInput("1"), 1_000);
    assert.equal(parseTurnWaitSecondsInput("60"), 60_000);
    assert.equal(parseTurnWaitSecondsInput("0"), null);
    assert.equal(parseTurnWaitSecondsInput("60.001"), null);
    assert.equal(parseTurnWaitSecondsInput("1.0001"), null);

    const savedConfig: PublicConfig = {
        ...config,
        replyJudge: { ...config.replyJudge, turnWaitMs: 12_500 },
    };
    form = settingsFormReducer(form, { type: "saved", config: savedConfig, field: "replyJudge.turnWaitMs" })!;
    assert.equal(form.values["replyJudge.turnWaitMs"], "12.5");
    assert.deepEqual(dirtySettingsFields(form), []);
});

test("settings external refresh reloads clean forms and preserves dirty edits with a conflict notice", () => {
    const changedConfig: PublicConfig = { ...config, replyJudge: { ...config.replyJudge, model: "external-judge" } };
    const clean = settingsFormReducer(createSettingsForm(config), { type: "server-refresh", config: changedConfig });
    assert.equal(clean?.baseline.replyJudge.model, "external-judge");
    assert.equal(clean?.values["replyJudge.model"], "external-judge");

    let dirty = settingsFormReducer(createSettingsForm(config), { type: "edit", field: "replyJudge.model", value: "my-unsaved-model" })!;
    dirty = settingsFormReducer(dirty, { type: "server-refresh", config: changedConfig })!;
    assert.equal(dirty.externalConflict, true);
    assert.equal(dirty.baseline.replyJudge.model, config.replyJudge.model);
    assert.equal(dirty.values["replyJudge.model"], "my-unsaved-model");
});

test("settings preset patches only selected provider while retaining hidden draft", () => {
    let form = createSettingsForm(config);
    form = settingsFormReducer(form, { type: "edit", field: "deepseek.model", value: "deepseek-custom" })!;
    form = settingsFormReducer(form, { type: "edit", field: "gpt.model", value: "gpt-custom" })!;
    assert.deepEqual(visibleDirtySettingsFields(form), ["gpt.model"]);
    assert.deepEqual(settingsPatches(form), [{ field: "gpt.model", value: "gpt-custom" }]);
    form = settingsFormReducer(form, { type: "edit", field: "aiProvider", value: "deepseek" })!;
    assert.deepEqual(visibleDirtySettingsFields(form), ["aiProvider", "deepseek.model"]);
    assert.deepEqual(settingsPatches(form), [{ field: "aiProvider", value: "deepseek" }, { field: "deepseek.model", value: "deepseek-custom" }]);
});

test("AI image settings edit independently and save all parameters as one validated patch", () => {
    let form = createSettingsForm(config);
    form = settingsFormReducer(form, { type: "edit", field: "image.enabled", value: true })!;
    form = settingsFormReducer(form, { type: "edit", field: "image.model", value: "gpt-image-2" })!;
    form = settingsFormReducer(form, { type: "edit", field: "image.quality", value: "high" })!;
    form = settingsFormReducer(form, { type: "edit", field: "image.size", value: "1536x1024" })!;
    form = settingsFormReducer(form, { type: "edit", field: "image.outputFormat", value: "webp" })!;

    assert.deepEqual(settingsPatches(form), [{
        field: "image",
        value: { enabled: true, provider: "gpt", model: "gpt-image-2", quality: "high", size: "1536x1024", outputFormat: "webp" },
    }]);
    assert.equal(form.values["gpt.model"], config.gpt.model, "image model edits never change the GPT conversation model");

    const profile = {
        quality: ["low", "medium", "high"] as const,
        sizes: ["1024x1024", "1536x1024", "1024x1536"] as const,
        outputFormats: ["png", "jpeg", "webp"] as const,
        supportsAutoSize: false,
        supportsCustomSize: false,
        source: "openai-sdk-profile" as const,
    };
    assert.equal(settingsFieldError("image.quality", form.values, profile), undefined);
    assert.match(settingsFieldError("image.quality", { ...form.values, "image.quality": "xhigh" }, profile) ?? "", /不支持质量/);

    const savedConfig: PublicConfig = { ...config, image: { ...config.image, enabled: true, model: "gpt-image-2", quality: "high", size: "1536x1024", outputFormat: "webp" } };
    form = settingsFormReducer(form, { type: "saved", config: savedConfig, field: "image" })!;
    assert.equal(form.values["image.model"], "gpt-image-2");
    assert.deepEqual(dirtySettingsFields(form), []);
});

test("settings center exposes four secondary pages with responsive desktop and mobile navigation", () => {
    assert.deepEqual(SETTINGS_PAGES.map((page) => page.id), ["model", "judge", "runtime", "image"]);
    const markup = renderToStaticMarkup(createElement(SettingsNavigation, {
        section: "judge", dirtySections: new Set(["image"]), onChange() {},
    }));
    assert.match(markup, /aria-label="设置分类"/);
    assert.equal((markup.match(/class="settings-nav-item/g) ?? []).length, 4);
    assert.match(markup, /settings-nav-item active" aria-current="page" aria-pressed="true"><span>回复判断/);
    assert.match(markup, /AI 绘图<\/span><span class="settings-nav-dirty" aria-label="有未保存更改"/);
    const css = readFileSync("web/src/styles.css", "utf8");
    assert.match(css, /\.settings-center \{ display: grid; grid-template-columns: 205px minmax\(0, 1fr\)/);
    assert.match(css, /@media \(max-width: 700px\)[\s\S]*?\.settings-center \{ grid-template-columns: minmax\(0, 1fr\)/);
    assert.match(css, /\.settings-navigation \{ position: sticky/);
    assert.match(css, /\.settings-navigation \{ position: static; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
});

test("settings categories cover each editable field exactly once", () => {
    const grouped = Object.values(SETTINGS_SECTION_FIELDS).flat();
    assert.equal(new Set(grouped).size, grouped.length);
    assert.deepEqual([...grouped].sort(), Object.keys(createSettingsForm(config).values).sort());
});

test("each settings page renders controls for its complete field category without secret values", () => {
    const edit = () => {};
    const common = { form: createSettingsForm(config), saving: false, fieldError: () => undefined, edit };
    const catalog = { catalog: null, loading: false, error: null, refresh() {} };
    const model = renderToStaticMarkup(createElement(ModelSettings, {
        ...common, ...catalog, showOtherModels: false, onShowOtherModelsChange() {}, customModel: false, onCustomModelChange() {},
    }));
    const deepseekForm = settingsFormReducer(createSettingsForm(config), { type: "edit", field: "aiProvider", value: "deepseek" })!;
    const deepseek = renderToStaticMarkup(createElement(ModelSettings, {
        ...common, form: deepseekForm, ...catalog, showOtherModels: false, onShowOtherModelsChange() {}, customModel: false, onCustomModelChange() {},
    }));
    const judge = renderToStaticMarkup(createElement(JudgeSettings, common));
    const runtime = renderToStaticMarkup(createElement(RuntimeSettings, common));
    const image = renderToStaticMarkup(createElement(ImageSettings, {
        ...common, ...catalog, customModel: false, onCustomModelChange() {}, customSizeSelected: false,
        onCustomSizeSelectedChange() {}, customWidth: "", onCustomWidthChange() {}, customHeight: "", onCustomHeightChange() {},
    }));

    for (const id of ["setting-gpt-model", "setting-gpt-reasoning", "setting-gpt-verbosity"]) assert.match(model, new RegExp(`id="${id}"`));
    assert.match(deepseek, /id="setting-deepseek-model"/);
    assert.match(deepseek, /id="setting-deepseek-reasoning"/);
    for (const id of ["setting-judge-model", "setting-judge-timeout", "setting-judge-ipo-fallback", "setting-judge-turn-wait"]) assert.match(judge, new RegExp(`id="${id}"`));
    for (const id of ["setting-meme-send-size", "setting-max-cycles"]) assert.match(runtime, new RegExp(`id="${id}"`));
    for (const id of ["setting-image-enabled", "setting-image-provider", "setting-image-model", "setting-image-quality", "setting-image-size", "setting-image-format"]) assert.match(image, new RegExp(`id="${id}"`));
    assert.doesNotMatch([model, deepseek, judge, runtime, image].join(""), /CODEX_API_KEY|SECRET_VALUE|PRIVATE_KEY/);
});

test("settings section routes survive refresh and browser back/forward URL changes", () => {
    const route = parseAppRoute("#/settings/image");
    assert.deepEqual(route, { page: "settings", settingsSection: "image" });
    assert.equal(appRouteHash(route), "#/settings/image");
    assert.deepEqual(parseAppRoute("#/settings/unknown"), { page: "settings", settingsSection: "model" });
    assert.deepEqual(parseAppRoute("#/members"), { page: "members", settingsSection: "model" });
});

test("settings page patches exclude drafts from other pages and saved fields leave other drafts intact", () => {
    let form = createSettingsForm(config);
    form = settingsFormReducer(form, { type: "edit", field: "gpt.model", value: "gpt-draft" })!;
    form = settingsFormReducer(form, { type: "edit", field: "replyJudge.model", value: "judge-draft" })!;
    form = settingsFormReducer(form, { type: "edit", field: "botLoopGuard.maxCycles", value: "8" })!;
    form = settingsFormReducer(form, { type: "edit", field: "image.model", value: "image-draft" })!;

    assert.deepEqual(dirtySettingsFieldsForSection(form, "model"), ["gpt.model"]);
    assert.deepEqual(settingsPatches(form, "judge"), [{ field: "replyJudge.model", value: "judge-draft" }]);
    assert.deepEqual(settingsPatches(form, "runtime"), [{ field: "botLoopGuard.maxCycles", value: 8 }]);
    assert.deepEqual(settingsPatches(form, "image"), [{
        field: "image",
        value: { enabled: false, provider: "gpt", model: "image-draft", quality: "low", size: "1024x1024", outputFormat: "png" },
    }]);

    const savedJudgeConfig: PublicConfig = { ...config, replyJudge: { ...config.replyJudge, model: "judge-draft" } };
    form = settingsFormReducer(form, { type: "saved", config: savedJudgeConfig, field: "replyJudge.model" })!;
    assert.equal(form.values["replyJudge.model"], "judge-draft");
    assert.equal(form.values["gpt.model"], "gpt-draft");
    assert.equal(form.values["image.model"], "image-draft");
    assert.deepEqual(settingsPatches(form, "model"), [{ field: "gpt.model", value: "gpt-draft" }]);
    assert.deepEqual(settingsPatches(form, "image").map((patch) => patch.field), ["image"]);
});

test("saving a field does not clear another draft that happens to match an external config update", () => {
    let form = createSettingsForm(config);
    form = settingsFormReducer(form, { type: "edit", field: "gpt.model", value: "gpt-draft" })!;
    form = settingsFormReducer(form, { type: "edit", field: "replyJudge.model", value: "external-judge" })!;
    const externalConfig: PublicConfig = { ...config, replyJudge: { ...config.replyJudge, model: "external-judge" } };
    form = settingsFormReducer(form, { type: "server-refresh", config: externalConfig })!;
    const savedConfig: PublicConfig = { ...externalConfig, gpt: { ...config.gpt, model: "gpt-draft" } };
    form = settingsFormReducer(form, { type: "saved", config: savedConfig, field: "gpt.model" })!;
    assert.equal(form.externalConflict, true);
    assert.deepEqual(dirtySettingsFieldsForSection(form, "judge"), ["replyJudge.model"]);
    assert.deepEqual(settingsPatches(form, "judge"), [{ field: "replyJudge.model", value: "external-judge" }]);
});

test("failed page save preserves unsaved fields and clears only patches already accepted by the server", async () => {
    let form = createSettingsForm(config);
    form = settingsFormReducer(form, { type: "edit", field: "replyJudge.model", value: "judge-draft" })!;
    form = settingsFormReducer(form, { type: "edit", field: "replyJudge.timeoutMs", value: "12000" })!;
    let writes = 0;
    const result = await saveSettingsChanges(form, "judge", async (patch) => {
        writes++;
        if (patch.field === "replyJudge.timeoutMs") throw new Error("disk unavailable");
        return {
            result: { ok: true, requiresRestart: false, changedFields: [patch.field], message: "saved" },
            config: { ...config, replyJudge: { ...config.replyJudge, model: "judge-draft" } },
        };
    }, (response, field) => { form = settingsFormReducer(form, { type: "saved", config: response.config, field })!; });

    assert.equal(writes, 2);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.saved, 1);
    assert.match(String(result.error), /disk unavailable/);
    assert.equal(form.values["replyJudge.model"], "judge-draft");
    assert.equal(form.values["replyJudge.timeoutMs"], "12000");
    assert.deepEqual(dirtySettingsFieldsForSection(form, "judge"), ["replyJudge.timeoutMs"]);
});

test("editor dirty state and navigation guard preserve unsaved content", () => {
    const resource = { id: "prompt:gpt" as const, displayName: "GPT", language: "markdown" as const, content: "Original", version: "v1" };
    const draft = createEditorDraft(resource);
    assert.equal(isEditorDirty(draft), false);
    assert.equal(isEditorDirty(editDraft(draft, "Edited")), true);
    assert.equal(nextPage("prompts", "models", true, false), "prompts");
    assert.equal(nextPage("prompts", "models", true, true), "models");
});

test("conversation reducer merges live messages and attempt transitions without stale timeline overwrite", () => {
    const start = conversationReducer(initialConversationViewState, { type: "event", event: { type: "conversation-item", conversationId: "id-1", kind: "group", label: "Group", item: { id: "m1", type: "peer-message", displayName: "Member", content: "hello", timestamp: "t1" } } });
    assert.equal(start.summaries[0]?.label, "Group");
    const loaded = conversationReducer(start, { type: "timeline", id: "id-1", items: [{ id: "m1", type: "peer-message", displayName: "Member", content: "hello", timestamp: "t1" }], atRevision: start.revision });
    const attempt = { id: "a1", type: "ai-attempt" as const, attemptId: "a1", cycleId: "c1", status: "generating" as const, timestamp: "t2" };
    const generating = conversationReducer(loaded, { type: "event", event: { type: "conversation-item", conversationId: "id-1", kind: "group", label: "Group", item: attempt } });
    assert.equal(generating.timelines["id-1"]?.length, 2);
    const failed = conversationReducer(generating, { type: "event", event: { type: "conversation-item", conversationId: "id-1", kind: "group", label: "Group", item: { ...attempt, status: "failed", timestamp: "t3" } } });
    assert.equal(failed.timelines["id-1"]?.length, 2);
    assert.equal(failed.timelines["id-1"]?.[1]?.type, "ai-attempt");
    const completed = conversationReducer(failed, { type: "event", event: { type: "conversation-item", conversationId: "id-1", kind: "group", label: "Group", item: { ...attempt, status: "completed", timestamp: "t4" } } });
    assert.equal(completed.timelines["id-1"]?.length, 1);
    assert.equal(conversationReducer(failed, { type: "timeline", id: "id-1", items: [], atRevision: 0 }), failed);
});

test("provider error Class C stays quiet and duplicate A/B notice aggregates", () => {
    const notice = { provider: "gpt", model: "gpt-test", tenbotCode: "R:A_MP_PSU", message: "safe", timestamp: "now" };
    assert.equal(isProminentProviderError(notice), true);
    assert.equal(isProminentProviderError({ ...notice, tenbotCode: "M:C_NS_NRL" }), false);
    const once = addNotice([], { id: 1, tone: "error", message: "safe", count: 1, details: notice });
    const twice = addNotice(once, { id: 2, tone: "error", message: "safe", count: 1, details: notice });
    assert.equal(twice.length, 1);
    assert.equal(twice[0]?.count, 2);
});

test("log reducer bounds the browser buffer, keeps append order, and clears only local entries", () => {
    let state = { ...initialLogViewState, entries: [] as LogEntry[] };
    for (let index = 0; index <= MAX_WEB_LOG_ENTRIES; index++) {
        state = logViewReducer(state, { type: "append", entry: { timestamp: String(index), level: "info", text: `line ${index}` } });
    }
    assert.equal(state.entries.length, MAX_WEB_LOG_ENTRIES);
    assert.equal(state.entries[0]?.text, "line 1");
    assert.equal(state.entries.at(-1)?.text, `line ${MAX_WEB_LOG_ENTRIES}`);
    const cleared = logViewReducer(state, { type: "clear" });
    assert.deepEqual(cleared.entries, []);
    assert.equal(state.entries.length, MAX_WEB_LOG_ENTRIES);
});

test("log filtering matches level and case-insensitive text; follow state counts unseen rows", () => {
    const entries: LogEntry[] = [
        { timestamp: "1", level: "debug", text: "Loading Config" },
        { timestamp: "2", level: "error", text: "Model FAILED" },
        { timestamp: "3", level: "info", text: "Runtime ready" },
        { timestamp: "4", level: "all", text: "raw payload" },
    ];
    assert.deepEqual(filterLogs(entries, "error", "failed"), [entries[1]]);
    assert.deepEqual(filterLogs(entries, "all", "CONFIG"), [entries[0]]);
    assert.deepEqual(filterLogs(entries, "all-level", ""), [entries[3]]);

    let state = logViewReducer(initialLogViewState, { type: "set-follow", follow: false });
    state = logViewReducer(state, { type: "append", entry: entries[0]! });
    assert.equal(state.follow, false);
    assert.equal(state.unseenCount, 1);
    state = logViewReducer(state, { type: "scroll-position", atBottom: true });
    assert.equal(state.follow, true);
    assert.equal(state.unseenCount, 0);
});

test("log level preference defaults to info, validates localStorage values, and survives remount", () => {
    const values = new Map<string, string>();
    const storage = {
        getItem(key: string) { return values.get(key) ?? null; },
        setItem(key: string, value: string) { values.set(key, value); },
    };
    assert.equal(LOG_LEVEL_FILTER_STORAGE_KEY, "tenbot.logs.level-filter");
    assert.equal(loadLogLevelFilter(), "info", "server/test environments without browser storage default to info");
    assert.equal(loadLogLevelFilter(storage), "info", "first visit defaults to info");

    values.set(LOG_LEVEL_FILTER_STORAGE_KEY, "debug");
    assert.equal(loadLogLevelFilter(storage), "debug");
    values.set(LOG_LEVEL_FILTER_STORAGE_KEY, "all-level");
    assert.equal(loadLogLevelFilter(storage), "all-level");
    for (const invalid of ["", "old", "warning", "ALL"]) {
        values.set(LOG_LEVEL_FILTER_STORAGE_KEY, invalid);
        assert.equal(loadLogLevelFilter(storage), "info");
    }

    saveLogLevelFilter("error", storage);
    assert.equal(values.get(LOG_LEVEL_FILTER_STORAGE_KEY), "error");
    assert.equal(loadLogLevelFilter(storage), "error", "a remounted page restores the saved filter");
});

test("log preference storage exceptions fall back safely without blocking selection", () => {
    const deniedRead = { getItem() { throw new DOMException("blocked", "SecurityError"); }, setItem() {} };
    assert.equal(loadLogLevelFilter(deniedRead), "info");
    assert.equal(loadLogLevelFilter({ getItem() { throw new Error("storage unavailable"); }, setItem() {} }), "info");

    const deniedWrite = { getItem() { return null; }, setItem() { throw new Error("quota exceeded"); } };
    let selection: "info" | "error" = "info";
    selection = "error";
    assert.doesNotThrow(() => saveLogLevelFilter(selection, deniedWrite));
    assert.equal(selection, "error", "React's selected value remains active when persistence fails");
    assert.equal(isLogLevelFilter("all-level"), true);
    assert.equal(isLogLevelFilter("broken"), false);
});

test("display filtering does not remove other levels from the browser log buffer", () => {
    const entries: LogEntry[] = [
        { timestamp: "1", level: "all", text: "complete" },
        { timestamp: "2", level: "debug", text: "debug" },
        { timestamp: "3", level: "info", text: "info" },
        { timestamp: "4", level: "warn", text: "warning" },
        { timestamp: "5", level: "error", text: "error" },
    ];
    let state = { ...initialLogViewState, entries: [] as LogEntry[] };
    state = logViewReducer(state, { type: "append-batch", entries });
    assert.equal(state.entries.length, 5);
    assert.deepEqual(filterLogs(state.entries, "info", ""), [entries[2]]);
    assert.deepEqual(filterLogs(state.entries, "all", "").map((entry) => entry.level), ["all", "debug", "info", "warn", "error"]);
});

test("log rows render only the newest 500 matches from the complete 5,000-row cache", () => {
    const entries: LogEntry[] = Array.from({ length: MAX_WEB_LOG_ENTRIES }, (_, index) => ({
        timestamp: String(index), level: "info", text: `line ${index}`,
    }));
    assert.equal(filterLogs(entries, "info", "line").length, MAX_WEB_LOG_ENTRIES);
    const html = renderToStaticMarkup(createElement(LogRows, { entries }));
    assert.equal((html.match(/class="log-row /g) ?? []).length, 500);
    assert.match(html, /line 4500/);
    assert.match(html, /line 4999/);
    assert.doesNotMatch(html, /line 4499/);
});

test("Vite API proxy streams SSE frames from the backend", async () => {
    const backend = createHttpServer((_request, response) => {
        response.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache",
        });
        response.flushHeaders();
        response.write('event: status\ndata: {"source":"proxy-ok"}\n\n');
    });
    await new Promise<void>((resolve, reject) => {
        backend.once("error", reject);
        backend.listen(0, "127.0.0.1", () => { backend.off("error", reject); resolve(); });
    });

    const backendAddress = backend.address();
    assert.ok(backendAddress && typeof backendAddress === "object");
    const vite = await createViteServer({
        configFile: false,
        root: "web",
        logLevel: "silent",
        server: {
            host: "127.0.0.1",
            port: 0,
            strictPort: false,
            proxy: {
                "/api": { target: `http://127.0.0.1:${backendAddress.port}`, changeOrigin: false },
            },
        },
    });
    const abortController = new AbortController();
    try {
        await vite.listen();
        const viteAddress = vite.httpServer?.address();
        assert.ok(viteAddress && typeof viteAddress === "object");
        const response = await fetch(`http://127.0.0.1:${viteAddress.port}/api/events`, { signal: abortController.signal });
        assert.equal(response.status, 200);
        assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
        assert.ok(response.body);
        const reader = response.body.getReader();
        const firstChunk = await reader.read();
        assert.ok(firstChunk.value);
        const frame = new TextDecoder().decode(firstChunk.value);
        assert.match(frame, /event: status/);
        assert.match(frame, /proxy-ok/);
        await reader.cancel();
    } finally {
        abortController.abort();
        await vite.close();
        await new Promise<void>((resolve) => backend.close(() => resolve()));
    }
});
