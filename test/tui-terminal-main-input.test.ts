import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PermissionManager } from "../src/permissions.ts";
import type { ModelRef } from "../src/models.ts";
import { SessionStore, type PersistedSession, type PersistedSessionMeta } from "../src/session-store.ts";
import { createInitialState, createTuiStore } from "../src/tui/state.ts";
import { TerminalAutocompleteController } from "../src/tui/terminal-autocomplete-controller.ts";
import { TerminalInputController } from "../src/tui/terminal-input-controller.ts";
import { TerminalAgentService } from "../src/tui/terminal-agent-service.ts";
import { handleInputAction, type InputDeps } from "../src/tui/terminal-main.ts";

function model(): ModelRef {
  return {
    id: "model",
    name: "Model",
    provider: "test",
    api: "openai-completions",
    protocol: "openai-compatible",
    baseUrl: "https://old.test/v1",
    apiKeyEnv: [],
    capabilities: { input: ["text"], tools: true },
    contextWindow: 4096,
    maxTokens: 256,
    reasoning: false,
  };
}

function dependencies(): InputDeps {
  const store = createTuiStore(createInitialState("model"));
  const permissionManager = new PermissionManager("plan");
  const service = new TerminalAgentService({
    store,
    llm: {
      apiKey: "",
      provider: "test",
      baseUrl: "https://old.test/v1",
      model: "model",
      capabilities: { input: ["text"], tools: true },
      contextWindow: 4096,
      maxTokens: 256,
      reasoning: false,
      imagePolicy: "strip",
      toolCallFormat: "openai",
    },
    tools: [],
    permissionManager,
    permissionSessionId: "test",
  });
  let input!: TerminalInputController;
  const autocomplete = new TerminalAutocompleteController({
    cwd: process.cwd(),
    getInput: () => input.getValue(),
    setInput: (value) => input.setValue(value),
  });
  input = new TerminalInputController({ onAction: () => {} });
  return {
    store,
    service,
    permissionManager,
    input,
    cwd: process.cwd(),
    autocomplete,
    sessionStore: new SessionStore("/tmp/mini-agent-terminal-main-input-test"),
    sessionRef: { current: "test" },
    planCaptureRef: { current: null },
    execCaptureRef: { current: null },
    allTools: [],
    runtimeContext: { sessionId: "test", workspaceId: process.cwd() },
    directAbortRef: {},
    setThinkingMode: () => {},
  } satisfies InputDeps;
}

describe("terminal main input routing", () => {
  it("uses prompt history for Up before falling back to scroll", () => {
    const deps = dependencies();
    deps.input.recordSubmission("previous prompt");
    deps.input.setValue("");

    handleInputAction({ type: "cursor", direction: "up" }, deps);

    assert.equal(deps.input.getValue(), "previous prompt");
    assert.equal(deps.store.getState().scrollOffset, 0);
  });

  it("keeps autocomplete navigation ahead of prompt history", () => {
    const deps = dependencies();
    let value = "/tasks ";
    deps.input.setValue(value);
    deps.autocomplete = new TerminalAutocompleteController({
      cwd: process.cwd(),
      getInput: () => value,
      setInput: (next) => { value = next; deps.input.setValue(next); },
    });
    deps.autocomplete.update(value);
    deps.input.recordSubmission("previous prompt");

    handleInputAction({ type: "cursor", direction: "up" }, deps);

    assert.equal(deps.autocomplete.getState().index, 4);
    assert.equal(deps.input.getValue(), "/tasks ");
    assert.equal(deps.store.getState().scrollOffset, 0);
  });

  it("moves the focused reasoning message without changing Agent history", () => {
    const deps = dependencies();
    deps.store.dispatch({ type: "USER_MESSAGE", text: "question" });
    deps.store.dispatch({ type: "LOOP_EVENT", event: { type: "assistant_delta", text: "reasoning", kind: "reasoning" } });
    deps.store.dispatch({ type: "LOOP_EVENT", event: { type: "assistant", message: { role: "assistant", content: "answer" } } });
    const before = deps.service.getHistory().length;

    handleInputAction({ type: "shortcut", name: "focus-message", direction: "increase" }, deps);

    assert.equal(deps.store.getState().focusedMessageIndex, 1);
    assert.equal(deps.service.getHistory().length, before);
  });

  it("keeps model setup sticky when Enter advances from base URL to API key", () => {
    const deps = dependencies();
    deps.autocomplete.openModelSetup({
      model: model(),
      baseUrl: "https://old.test/v1",
      apiKey: "",
      field: "baseUrl",
    });
    deps.input.setValue("https://new.test/v1");

    handleInputAction({ type: "submit", value: "https://new.test/v1" }, deps);

    assert.equal(deps.autocomplete.getState().mode, "model-setup");
    assert.equal(deps.autocomplete.getState().modelSetup?.field, "apiKey");
    assert.equal(deps.autocomplete.getState().modelSetup?.baseUrl, "https://new.test/v1");
  });

  it("handles /copy locally instead of starting a model turn", async () => {
    const deps = dependencies();
    deps.input.setValue("/copy");

    handleInputAction({ type: "submit", value: "/copy" }, deps);
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(deps.service.getHistory().filter((message) => message.role === "user").length, 0);
    const notice = deps.store.getState().messages.at(-1);
    assert.equal(notice?.kind, "notice");
    assert.match(notice?.kind === "notice" ? notice.text : "", /没有可复制/);
  });

  it("restores the visible transcript for the bare resume command", async () => {
    const deps = dependencies();
    const session: PersistedSession = {
      id: "resume-session",
      createdAt: 1,
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "previous question" },
        { role: "assistant", content: "previous answer" },
      ],
    };
    const meta: PersistedSessionMeta = {
      id: session.id,
      createdAt: session.createdAt,
      lastActiveAt: 2,
      messageCount: session.messages.length,
      preview: "previous question",
    };
    deps.sessionAccess = {
      list: async () => [meta],
      load: async () => session,
      newSession: () => "new-session",
      setSessionId: () => undefined,
      restoreHistory: (value, prompt) => [{ role: "system", content: prompt }, ...value.messages.slice(1)],
    };

    deps.input.setValue("resume");
    handleInputAction({ type: "submit", value: "resume" }, deps);
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.deepEqual(
      deps.store.getState().messages.filter((message) => message.kind === "user" || message.kind === "assistant"),
      [
        { kind: "user", text: "previous question" },
        { kind: "assistant", text: "previous answer" },
      ],
    );
    assert.equal(deps.service.getHistory().at(-1)?.content, "previous answer");
  });

  it("submits a fully typed /resume id instead of consuming Enter for completion", async () => {
    const deps = dependencies();
    const session: PersistedSession = {
      id: "abc123",
      createdAt: 1,
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "restored" },
      ],
    };
    deps.sessionAccess = {
      list: async () => [{ id: session.id, createdAt: 1, lastActiveAt: 2, messageCount: 2, preview: "restored" }],
      load: async () => session,
      newSession: () => "new-session",
      setSessionId: () => undefined,
      restoreHistory: (value, prompt) => [{ role: "system", content: prompt }, ...value.messages.slice(1)],
    };
    deps.autocomplete = new TerminalAutocompleteController({
      cwd: process.cwd(),
      getInput: () => deps.input.getValue(),
      setInput: (value) => deps.input.setValue(value),
      listSessionIds: async () => [session.id],
    });
    deps.input.setValue("/resume abc123");
    deps.autocomplete.update();
    await new Promise((resolve) => setTimeout(resolve, 10));

    handleInputAction({ type: "submit", value: "/resume abc123" }, deps);
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(deps.store.getState().messages.find((message) => message.kind === "user")?.text, "restored");
    assert.equal(deps.autocomplete.getState().mode, null);
  });

  it("resumes the selected session when Enter is pressed in the session picker", async () => {
    const deps = dependencies();
    const session: PersistedSession = {
      id: "picker-session",
      createdAt: 1,
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "picked prompt" },
      ],
    };
    let listCalls = 0;
    deps.sessionAccess = {
      list: async () => {
        listCalls += 1;
        return [{ id: session.id, createdAt: 1, lastActiveAt: 2, messageCount: 2, preview: "picked prompt" }];
      },
      load: async () => session,
      newSession: () => "new-session",
      setSessionId: () => undefined,
      restoreHistory: (value, prompt) => [{ role: "system", content: prompt }, ...value.messages.slice(1)],
    };
    deps.autocomplete = new TerminalAutocompleteController({
      cwd: process.cwd(),
      getInput: () => deps.input.getValue(),
      setInput: (value) => deps.input.setValue(value),
      listSessions: () => deps.sessionAccess!.list(),
    });
    deps.input.setValue("/resume");
    deps.autocomplete.update();
    await new Promise((resolve) => setTimeout(resolve, 10));

    handleInputAction({ type: "submit", value: "/resume" }, deps);
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(deps.store.getState().messages.find((message) => message.kind === "user")?.text, "picked prompt");
    assert.equal(deps.autocomplete.getState().mode, null);
    assert.equal(listCalls, 1, "resuming the selected metadata must not list sessions a second time");
  });

  it("resumes the selected session when the picker was opened with /sessions", async () => {
    const deps = dependencies();
    const session: PersistedSession = {
      id: "sessions-picker",
      createdAt: 1,
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "picked from sessions" },
      ],
    };
    deps.sessionAccess = {
      list: async () => [{ id: session.id, createdAt: 1, lastActiveAt: 2, messageCount: 1, preview: "picked from sessions" }],
      load: async () => session,
      newSession: () => "new-session",
      setSessionId: () => undefined,
      restoreHistory: (value, prompt) => [{ role: "system", content: prompt }, ...value.messages.slice(1)],
    };
    deps.autocomplete = new TerminalAutocompleteController({
      cwd: process.cwd(),
      getInput: () => deps.input.getValue(),
      setInput: (value) => deps.input.setValue(value),
      listSessions: () => deps.sessionAccess!.list(),
    });
    deps.input.setValue("/sessions");
    deps.autocomplete.update();
    await new Promise((resolve) => setTimeout(resolve, 10));

    handleInputAction({ type: "submit", value: "/sessions" }, deps);
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(deps.store.getState().messages.find((message) => message.kind === "user")?.text, "picked from sessions");
    assert.equal(deps.autocomplete.getState().mode, null);
  });

  it("does not relist after Enter on an empty settled session picker", async () => {
    const deps = dependencies();
    let listCalls = 0;
    deps.sessionAccess = {
      list: async () => {
        listCalls += 1;
        return [];
      },
      load: async () => undefined,
      newSession: () => "new-session",
      setSessionId: () => undefined,
      restoreHistory: () => [],
    };
    deps.autocomplete = new TerminalAutocompleteController({
      cwd: process.cwd(),
      getInput: () => deps.input.getValue(),
      setInput: (value) => deps.input.setValue(value),
      listSessions: () => deps.sessionAccess!.list(),
    });
    deps.input.setValue("/resume");
    deps.autocomplete.update();
    await new Promise((resolve) => setTimeout(resolve, 10));

    handleInputAction({ type: "submit", value: "/resume" }, deps);
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(listCalls, 1);
    const notice = deps.store.getState().messages.at(-1);
    assert.match(notice?.kind === "notice" ? notice.text : "", /没有可恢复的会话/);
  });
});
