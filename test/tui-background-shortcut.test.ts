/// <reference types="../ink-testing-library.d.ts" />
import assert from "node:assert/strict";
import { it } from "node:test";
import React, { useRef } from "react";
import { useKeyboardHandler } from "../src/tui/hooks/useKeyboardHandler.ts";
import type { TuiAction } from "../src/tui/state.ts";

const render = (await import("ink-testing-library")).render;

it("Ctrl+G promotes the foreground command through the TUI keyboard handler", async () => {
  const actions: TuiAction[] = [];
  let promoted = false;

  function KeyboardHarness(): React.ReactElement {
    useKeyboardHandler({
      exit: () => {},
      abortRef: useRef(new AbortController()),
      copyResolvedText: async () => {},
      pasteImage: async () => false,
      getPermissionManager: () => ({ getMode: () => "plan" }) as never,
      historyRef: useRef([]),
      adjustThinkingLevel: () => {},
      resolvePendingPermission: () => false,
      dispatch: (action) => actions.push(action),
      acMode: null,
      state: { busy: true, phase: "tools" },
      feedHeight: 10,
      handleAutocompleteKey: () => false,
      suppressInputEchoRef: useRef(false),
      pendingPermissionRef: useRef(false),
      backgroundForegroundTask: async () => {
        promoted = true;
        return "bg_123abc";
      },
    });
    return React.createElement(React.Fragment);
  }

  const view = render(React.createElement(KeyboardHarness));
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    view.stdin.write("\x07");
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(promoted, true);
    assert.ok(actions.some((action) => action.type === "ADD_NOTICE"
      && action.title === "Background task"
      && action.text.includes("bg_123abc")));
  } finally {
    view.cleanup();
  }
});
