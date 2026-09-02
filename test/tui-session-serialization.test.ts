import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createSessionPickerState,
  fromPersistedTodos,
  findSessionByPrefix,
  formatAmbiguousSessionNotice,
  moveSessionPicker,
  resolveSessionByPrefix,
  getExplicitStartupSessionId,
  getStartupSessionRequest,
  parseResumeCommand,
  restoreTuiSession,
  selectedSessionFromPicker,
  toPersistedTodos,
} from "../src/tui/session-serialization.ts";
import type { AgentMessage } from "../src/types.ts";

describe("TUI session serialization", () => {
  it("moves through session picker candidates and returns the selected session", () => {
    const picker = createSessionPickerState("resume", [
      { id: "first", createdAt: 1, lastActiveAt: 3, messageCount: 1, preview: "one" },
      { id: "second", createdAt: 1, lastActiveAt: 2, messageCount: 1, preview: "two" },
    ], false);
    assert.equal(selectedSessionFromPicker(picker)?.id, "first");
    assert.equal(selectedSessionFromPicker(moveSessionPicker(picker, 1))?.id, "second");
    assert.equal(selectedSessionFromPicker(moveSessionPicker(picker, -1))?.id, "second");
    assert.equal(selectedSessionFromPicker(moveSessionPicker(picker, 2))?.id, "first");
    const loadingPicker = createSessionPickerState("resume");
    assert.equal(moveSessionPicker(loadingPicker, 1), loadingPicker);
    assert.equal(selectedSessionFromPicker(createSessionPickerState("resume", [], false)), undefined);
  });

  it("starts a fresh session unless a session id is explicitly supplied", () => {
    assert.equal(getExplicitStartupSessionId({}), undefined);
    assert.equal(getExplicitStartupSessionId({ MINI_AGENT_SESSION_ID: "  session-123  " }), "session-123");
    assert.equal(getExplicitStartupSessionId({ MINI_AGENT_SESSION_ID: "   " }), undefined);
  });

  it("parses --continue and --resume startup requests for every TUI entrypoint", () => {
    assert.deepEqual(getStartupSessionRequest(["--continue"], {}), {
      sessionId: undefined,
      resume: true,
      fork: false,
    });
    assert.deepEqual(getStartupSessionRequest(["--resume", "abc123", "--fork-session"], {}), {
      sessionId: "abc123",
      resume: true,
      fork: true,
    });
    assert.deepEqual(getStartupSessionRequest(["--resume"], { MINI_AGENT_SESSION_ID: "env-session" }), {
      sessionId: "env-session",
      resume: true,
      fork: false,
    });
    assert.deepEqual(getStartupSessionRequest(["--fork-session"], {}), {
      sessionId: undefined,
      resume: true,
      fork: true,
    });
  });

  it("parses complete resume commands with or without the slash", () => {
    assert.deepEqual(parseResumeCommand("/resume abc"), { prefix: "abc" });
    assert.deepEqual(parseResumeCommand(" /ReSuMe  "), { prefix: "" });
    assert.deepEqual(parseResumeCommand("resume abc"), { prefix: "abc" });
    assert.deepEqual(parseResumeCommand("resume"), { prefix: "" });
    assert.equal(parseResumeCommand("/resumexyz"), undefined);
    assert.equal(parseResumeCommand("resumexyz"), undefined);
    assert.equal(findSessionByPrefix([
      { id: "abc-1", createdAt: 1, lastActiveAt: 2, messageCount: 1, preview: "first" },
      { id: "def-2", createdAt: 1, lastActiveAt: 1, messageCount: 1, preview: "second" },
    ], "def")?.id, "def-2");

    const sessions = [
      { id: "abc-1", createdAt: 1, lastActiveAt: 2, messageCount: 1, preview: "first" },
      { id: "abc-2", createdAt: 1, lastActiveAt: 1, messageCount: 1, preview: "second" },
    ];
    assert.equal(findSessionByPrefix(sessions, "abc"), undefined);
    assert.deepEqual(resolveSessionByPrefix(sessions, "abc").candidates.map(({ id }) => id), ["abc-1", "abc-2"]);
    assert.equal(resolveSessionByPrefix(sessions, "abc-2").session?.id, "abc-2");
    assert.match(formatAmbiguousSessionNotice("abc", sessions), /abc-1/);
    assert.match(formatAmbiguousSessionNotice("abc", sessions), /msgs=1/);
  });

  it("normalizes TUI-only todo statuses for persistence and restores the TUI shape", () => {
    const persisted = toPersistedTodos([
      { id: "done", content: "Done", activeForm: "Finishing", status: "completed", source: "model" },
      { id: "failed", content: "Failed", activeForm: "Retrying", status: "failed", source: "plan", error: "nope" },
    ]);

    assert.deepEqual(persisted, [
      { id: "done", content: "Done", activeForm: "Finishing", status: "completed" },
      { id: "failed", content: "Failed", activeForm: "Retrying", status: "pending" },
    ]);
    assert.deepEqual(fromPersistedTodos([
      { id: "restored", content: "Restore", status: "pending" },
    ]), [
      { id: "restored", content: "Restore", activeForm: "Restore", status: "pending", source: "model" },
    ]);
  });

  it("restores history through the supplied session boundary", () => {
    const session = {
      id: "session",
      createdAt: 1,
      messages: [{ role: "user", content: "hello" }] as AgentMessage[],
      todoVersion: 7,
    };
    const restored = restoreTuiSession(session, "system", (value, prompt) => [
      { role: "system", content: prompt },
      ...value.messages,
    ]);

    assert.deepEqual(restored.history, [
      { role: "system", content: "system" },
      { role: "user", content: "hello" },
    ]);
    assert.equal(restored.todoRevision, 7);
  });
});
