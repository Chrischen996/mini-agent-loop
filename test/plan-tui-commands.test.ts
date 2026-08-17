import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SLASH_COMMANDS } from "../src/tui/components/FileAutocomplete.tsx";

describe("TUI plan slash commands", () => {
  const names = SLASH_COMMANDS.map((cmd) => cmd.name);

  it("registers plan workflow commands before help/exit", () => {
    const required = [
      "plan",
      "plan-show",
      "plan-approve",
      "plan-reject",
      "plan-run",
      "plan-retry",
      "plan-history",
      "plan-archive",
    ];
    for (const name of required) {
      assert.ok(names.includes(name), `missing slash command: ${name}`);
    }

    const helpIndex = names.indexOf("help");
    const planIndex = names.indexOf("plan");
    assert.ok(planIndex >= 0 && helpIndex >= 0);
    assert.ok(planIndex < helpIndex, "plan commands should appear before help");
  });

  it("exposes Chinese usage descriptions for plan commands", () => {
    const plan = SLASH_COMMANDS.find((cmd) => cmd.name === "plan");
    assert.equal(plan?.usage, "/plan [task]");
    assert.match(plan?.description ?? "", /plan mode|计划/i);

    const run = SLASH_COMMANDS.find((cmd) => cmd.name === "plan-run");
    assert.equal(run?.usage, "/plan-run");
  });
});
