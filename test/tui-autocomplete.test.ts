import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  currentAutocompleteNavIndex,
  extractInlineModelQuery,
  isExactSlashCommand,
  isCommandPaletteInput,
  isOverlayAcMode,
  isPickerAcMode,
  isStickyAcMode,
  matchSlashCommands,
  nextClampedIndex,
  nextWrappedIndex,
  resolveAutocompleteInput,
  resolveAutocompleteNav,
  sessionListCommand,
} from "../src/tui/autocomplete.ts";
import { SLASH_COMMANDS } from "../src/tui/components/FileAutocomplete.tsx";

describe("autocomplete index helpers", () => {
  it("wraps around a non-empty list", () => {
    assert.equal(nextWrappedIndex(0, -1, 3), 2);
    assert.equal(nextWrappedIndex(2, 1, 3), 0);
    assert.equal(nextWrappedIndex(1, 1, 3), 2);
  });

  it("stays at 0 for an empty list", () => {
    assert.equal(nextWrappedIndex(0, 1, 0), 0);
    assert.equal(nextClampedIndex(0, -1, 0), 0);
  });

  it("clamps file-picker movement", () => {
    assert.equal(nextClampedIndex(0, -1, 4), 0);
    assert.equal(nextClampedIndex(3, 1, 4), 3);
    assert.equal(nextClampedIndex(1, 1, 4), 2);
  });
});

describe("autocomplete mode helpers", () => {
  it("classifies sticky overlay modes", () => {
    assert.equal(isStickyAcMode("model-setup"), true);
    assert.equal(isStickyAcMode("profile-name"), true);
    assert.equal(isStickyAcMode("profile-list"), true);
    assert.equal(isStickyAcMode("command"), false);
    assert.equal(isStickyAcMode(null), false);
  });

  it("classifies picker modes and overlays", () => {
    assert.equal(isPickerAcMode("file"), true);
    assert.equal(isPickerAcMode("model-picker"), true);
    assert.equal(isPickerAcMode("model-setup"), false);
    assert.equal(isOverlayAcMode("profile-list"), true);
    assert.equal(isOverlayAcMode("command"), true);
    assert.equal(isOverlayAcMode(null), false);
  });
});

describe("autocomplete input resolution", () => {
  it("treats a slash token with no space as the command palette", () => {
    assert.equal(isCommandPaletteInput("/mo"), true);
    assert.equal(isCommandPaletteInput("/model"), true);
    assert.equal(isCommandPaletteInput("/model "), false);
    assert.equal(isCommandPaletteInput("hello"), false);
  });

  it("filters slash commands by prefix", () => {
    const matches = matchSlashCommands("/pl", SLASH_COMMANDS);
    assert.ok(matches.every((command) => command.name.startsWith("pl")));
    assert.ok(matches.some((command) => command.name === "plan"));
  });

  it("opens the saved-session picker for complete session commands", () => {
    assert.equal(sessionListCommand("/sessions"), "sessions");
    assert.equal(sessionListCommand("/resume"), "resume");
    assert.equal(sessionListCommand("resume"), "resume");
    assert.equal(sessionListCommand("/resume abc"), null);
    assert.deepEqual(resolveAutocompleteInput("/resume", null), {
      kind: "session-list",
      command: "resume",
    });
    assert.deepEqual(resolveAutocompleteInput("/sessions", null), {
      kind: "session-list",
      command: "sessions",
    });
  });

  it("recognizes a fully typed slash command for direct submission", () => {
    assert.equal(isExactSlashCommand("/plan-show", "plan-show"), true);
    assert.equal(isExactSlashCommand(" /PLAN-SHOW ", "plan-show"), true);
    assert.equal(isExactSlashCommand("/plan", "plan-show"), false);
    assert.equal(isExactSlashCommand("/resume abc123", "resume", ["abc123"]), true);
    assert.equal(isExactSlashCommand("/resume abc", "resume", ["abc123"]), false);
  });

  it("keeps bare /model on the command palette instead of the model picker", () => {
    const resolution = resolveAutocompleteInput("/model", null);
    assert.equal(resolution.kind, "command");
    if (resolution.kind === "command") {
      assert.ok(resolution.candidates.some((command) => command.name === "model"));
    }
  });

  it("opens the inline model picker after /model plus a query", () => {
    assert.equal(extractInlineModelQuery("/model"), null);
    assert.equal(extractInlineModelQuery("/model grok"), "grok");
    const resolution = resolveAutocompleteInput("/model grok", null);
    assert.deepEqual(resolution, { kind: "model", query: "grok" });
  });

  it("does not treat overlay field values as slash/file triggers", () => {
    assert.equal(resolveAutocompleteInput("/read src", "model-setup").kind, "sticky");
    assert.equal(resolveAutocompleteInput("/plan", "profile-name").kind, "sticky");
    assert.equal(resolveAutocompleteInput("@src", "profile-list").kind, "sticky");
  });

  it("keeps filtering while the dedicated model picker is open", () => {
    assert.deepEqual(resolveAutocompleteInput("grok", "model-picker"), {
      kind: "model-picker",
      query: "grok",
    });
  });

  it("resolves @file and slash-path triggers", () => {
    const atRef = resolveAutocompleteInput("see @src", null);
    assert.equal(atRef.kind, "file");
    if (atRef.kind === "file") {
      assert.equal(atRef.trigger.fragment, "src");
    }

    const slashPath = resolveAutocompleteInput("/read src/tui", null);
    assert.equal(slashPath.kind, "file");
    if (slashPath.kind === "file") {
      assert.equal(slashPath.trigger.fragment, "src/tui");
      assert.equal(slashPath.trigger.replaceFn("src/tui/App.tsx"), "/read src/tui/App.tsx");
    }
  });

  it("clears when there is no trigger", () => {
    assert.equal(resolveAutocompleteInput("hello world", null).kind, "none");
  });
});

describe("autocomplete keyboard mapping", () => {
  const lengths = { commands: 4, files: 3, models: 5, profiles: 2 };

  it("wraps command palette arrows and accepts Tab", () => {
    assert.deepEqual(
      resolveAutocompleteNav("command", { upArrow: true }, 0, lengths),
      { type: "move", index: 3 },
    );
    assert.deepEqual(
      resolveAutocompleteNav("command", { tab: true }, 1, lengths),
      { type: "accept-command" },
    );
  });

  it("navigates and accepts saved-session candidates", () => {
    const sessionLengths = { commands: 0, files: 0, models: 0, profiles: 0, sessions: 2 };
    assert.deepEqual(
      resolveAutocompleteNav("session-list", { downArrow: true }, 0, sessionLengths),
      { type: "move", index: 1 },
    );
    assert.deepEqual(
      resolveAutocompleteNav("session-list", { tab: true }, 1, sessionLengths),
      { type: "accept-session" },
    );
  });

  it("clamps file arrows and accepts Tab or right arrow", () => {
    assert.deepEqual(
      resolveAutocompleteNav("file", { upArrow: true }, 0, lengths),
      { type: "move", index: 0 },
    );
    assert.deepEqual(
      resolveAutocompleteNav("file", { rightArrow: true }, 1, lengths),
      { type: "accept-file" },
    );
  });

  it("fills /model on Tab and clears input on Escape", () => {
    assert.deepEqual(
      resolveAutocompleteNav("model-picker", { tab: true }, 2, lengths),
      { type: "accept-model" },
    );
    assert.deepEqual(
      resolveAutocompleteNav("model", { escape: true }, 0, lengths),
      { type: "cancel", clearInput: true },
    );
  });

  it("owns sticky overlay keys so App shortcuts do not fire", () => {
    assert.deepEqual(
      resolveAutocompleteNav("model-setup", { upArrow: true }, 0, lengths),
      { type: "ignore" },
    );
    assert.deepEqual(
      resolveAutocompleteNav("profile-name", { escape: true }, 0, lengths),
      { type: "cancel", clearInput: true },
    );
    assert.deepEqual(
      resolveAutocompleteNav("profile-list", { downArrow: true }, 0, lengths),
      { type: "move", index: 1 },
    );
    assert.deepEqual(
      resolveAutocompleteNav("profile-list", { downArrow: true }, 1, lengths),
      { type: "move", index: 0 },
    );
  });

  it("uses the profile selectedIndex instead of the shared acIndex", () => {
    assert.equal(currentAutocompleteNavIndex("profile-list", 0, 2), 2);
    assert.equal(currentAutocompleteNavIndex("command", 3, 2), 3);
  });

  it("does not steal keys when no overlay is open", () => {
    assert.deepEqual(
      resolveAutocompleteNav(null, { tab: true }, 0, lengths),
      { type: "none" },
    );
  });
});
