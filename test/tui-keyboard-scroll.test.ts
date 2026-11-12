/// <reference types="../ink-testing-library.d.ts" />
import assert from "node:assert/strict";
import { it } from "node:test";
import React, { useRef } from "react";
import { useKeyboardHandler } from "../src/tui/hooks/useKeyboardHandler.ts";
import type { TuiAction } from "../src/tui/state.ts";

const render = (await import("ink-testing-library")).render;

it("scrolls one page with PageUp and emits no duplicate scroll actions", async () => {
  const actions: TuiAction[] = [];
  const scrolls: number[] = [];

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
      scrollBy: (delta) => scrolls.push(delta),
      acMode: null,
      state: { busy: false, phase: "idle" },
      feedHeight: 10,
      handleAutocompleteKey: () => false,
      suppressInputEchoRef: useRef(false),
      pendingPermissionRef: useRef(false),
    });
    return React.createElement(React.Fragment);
  }

  const view = render(React.createElement(KeyboardHarness));
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    view.stdin.write("\x1b[5~");
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(scrolls, [8]);
    assert.deepEqual(actions, []);
  } finally {
    view.cleanup();
  }
});
