import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SLASH_COMMANDS, formatHelpNotice } from "../src/tui/slash-commands.ts";
import { buildStatusSegments } from "../src/tui/status-line.ts";

describe("bg-tasks TUI surface", () => {
  it("registers /bg-tasks in the slash command catalog", () => {
    const command = SLASH_COMMANDS.find((entry) => entry.name === "bg-tasks");
    assert.ok(command);
    assert.equal(command!.usage, "/bg-tasks");
    assert.match(command!.description, /background task/i);
  });

  it("lists /bg-tasks in the help notice", () => {
    const help = formatHelpNotice();
    assert.match(help, /\/bg-tasks/);
  });

  it("keeps status segments free of a background-task segment by default", () => {
    const segments = buildStatusSegments({
      modelName: "model",
      permissionMode: "plan",
      contextTokens: 0,
      busy: false,
    });
    assert.ok(!segments.some((segment) => segment.text.includes("bg task")));
  });
});
