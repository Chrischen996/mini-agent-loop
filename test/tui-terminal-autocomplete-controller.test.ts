import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TerminalAutocompleteController } from "../src/tui/terminal-autocomplete-controller.ts";

describe("terminal autocomplete controller", () => {
  it("navigates and accepts command candidates through one input value", () => {
    let value = "/";
    const controller = new TerminalAutocompleteController({
      cwd: process.cwd(),
      getInput: () => value,
      setInput: (next) => { value = next; },
    });

    controller.update();
    assert.equal(controller.getState().mode, "command");
    assert.ok(controller.getState().commands.length > 0);
    controller.handleKey({ downArrow: true });
    assert.equal(controller.getState().index, 1);
    controller.handleKey({ tab: true });
    assert.ok(value.startsWith("/"));
    assert.equal(controller.getState().mode, null);
  });

  it("invalidates stale file scans when input changes", async () => {
    let value = "src/tui/term";
    const controller = new TerminalAutocompleteController({
      cwd: process.cwd(),
      getInput: () => value,
      setInput: (next) => { value = next; },
    });

    controller.update();
    value = "/";
    controller.update();
    await new Promise((resolve) => setTimeout(resolve, 220));
    assert.equal(controller.getState().mode, "command");
    assert.equal(controller.getState().fileFragment, "");
  });

  it("keeps model setup as a sticky overlay and advances to the API key field", () => {
    let value = "";
    const controller = new TerminalAutocompleteController({
      cwd: process.cwd(),
      getInput: () => value,
      setInput: (next) => { value = next; },
    });
    const model = {
      id: "test-model",
      name: "Test",
      provider: "test",
      api: "openai-completions" as const,
      protocol: "openai-compatible" as const,
      baseUrl: "https://example.test/v1",
      apiKeyEnv: [],
      capabilities: { input: ["text" as const], tools: true },
      contextWindow: 4096,
      maxTokens: 256,
      reasoning: false,
    };
    controller.openModelSetup({ model, baseUrl: model.baseUrl, apiKey: "", field: "baseUrl" });
    assert.equal(controller.getState().mode, "model-setup");
    controller.update("/ignored");
    assert.equal(controller.getState().mode, "model-setup");
    controller.setModelSetup({ model, baseUrl: model.baseUrl, apiKey: "", field: "apiKey" });
    assert.equal(controller.getState().modelSetup?.field, "apiKey");
  });

  it("moves the profile-list selection independently of the shared index", () => {
    const controller = new TerminalAutocompleteController({
      cwd: process.cwd(),
      getInput: () => "",
      setInput: () => {},
    });
    controller.openProfileList({
      selectedIndex: 0,
      profiles: [
        { name: "one", active: false, model: "a/b", baseUrl: "https://a" },
        { name: "two", active: false, model: "c/d", baseUrl: "https://c" },
      ],
    });
    controller.handleKey({ downArrow: true });
    assert.equal(controller.getState().profileListState?.selectedIndex, 1);
    assert.equal(controller.getState().index, 0);
  });

  it("completes finite slash-command arguments", () => {
    let value = "/tasks ";
    const controller = new TerminalAutocompleteController({
      cwd: process.cwd(),
      getInput: () => value,
      setInput: (next) => { value = next; },
    });

    controller.update();
    assert.equal(controller.getState().mode, "command");
    assert.deepEqual(controller.getState().argumentCandidates, ["show", "hide", "compact", "expanded", "clear"]);
    controller.handleKey({ downArrow: true });
    controller.handleKey({ tab: true });
    assert.equal(value, "/tasks hide");
    assert.equal(controller.getState().mode, null);
  });

  it("loads session IDs for /resume completion and ignores stale results", async () => {
    let value = "/resume a";
    const controller = new TerminalAutocompleteController({
      cwd: process.cwd(),
      getInput: () => value,
      setInput: (next) => { value = next; },
      listSessionIds: async () => ["abc123", "def456"],
    });

    controller.update();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(controller.getState().mode, "command");
    assert.deepEqual(controller.getState().argumentCandidates, ["abc123"]);
    controller.handleKey({ tab: true });
    assert.equal(value, "/resume abc123");
  });

  it("loads visible session metadata for a bare /resume picker", async () => {
    let value = "/resume";
    const controller = new TerminalAutocompleteController({
      cwd: process.cwd(),
      getInput: () => value,
      setInput: (next) => { value = next; },
      listSessions: async () => [
        { id: "abc123", createdAt: 1, lastActiveAt: 3, messageCount: 4, preview: "first prompt" },
        { id: "def456", createdAt: 1, lastActiveAt: 2, messageCount: 2, preview: "second prompt" },
      ],
    });

    controller.update();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(controller.getState().mode, "session-list");
    assert.deepEqual(controller.getState().sessions.map((session) => session.id), ["abc123", "def456"]);
    controller.handleKey({ downArrow: true });
    controller.handleKey({ tab: true });
    assert.equal(value, "/resume def456");
    assert.equal(controller.getState().mode, null);
  });

  it("filters command candidates while the session command is still being typed", () => {
    let value = "/s";
    const controller = new TerminalAutocompleteController({
      cwd: process.cwd(),
      getInput: () => value,
      setInput: (next) => { value = next; },
    });

    controller.update();
    assert.deepEqual(controller.getState().commands.map((command) => command.name), ["sessions", "skill", "skills"]);
    value = "/sess";
    controller.update();
    assert.deepEqual(controller.getState().commands.map((command) => command.name), ["sessions"]);
  });
});
