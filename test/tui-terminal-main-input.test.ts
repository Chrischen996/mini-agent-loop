import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PermissionManager } from "../src/permissions.ts";
import type { ModelRef } from "../src/models.ts";
import { SessionStore } from "../src/session-store.ts";
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

function dependencies() {
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
});
