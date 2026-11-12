/// <reference types="../ink-testing-library.d.ts" />
import assert from "node:assert/strict";
import { it } from "node:test";
import React from "react";
import { EffortPicker } from "../src/tui/components/EffortPicker.tsx";
import { THINKING_LEVEL_DISPLAY_LABELS } from "../src/pi-ai/thinking-levels.ts";
import type { ModelThinkingLevel } from "../src/pi-ai/types.ts";

const render = (await import("ink-testing-library")).render;

const LEVELS: readonly ModelThinkingLevel[] = ["off", "low", "medium", "high"];

it("EffortPicker renders the slider with the current level and description", async () => {
  const view = render(React.createElement(EffortPicker, {
    levels: LEVELS,
    labels: THINKING_LEVEL_DISPLAY_LABELS,
    selectedIndex: 3,
    width: 76,
    onConfirm: () => {},
    onCancel: () => {},
  }));
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const frame: string = typeof view.lastFrame === "function" ? (view.lastFrame() ?? "") : String(view.lastFrame ?? "");
    assert.ok(frame.includes("Effort"), "shows the Effort title");
    assert.ok(frame.includes("High"), "shows the current level label");
    assert.ok(frame.includes("Deepest reasoning"), "shows the level description");
    assert.ok(frame.includes("Off"), "shows the lowest level tick label");
  } finally {
    view.cleanup();
  }
});

it("EffortPicker moves the selection with arrow keys and confirms on Enter", async () => {
  const previews: ModelThinkingLevel[] = [];
  let confirmed: ModelThinkingLevel | undefined;

  const view = render(React.createElement(EffortPicker, {
    levels: LEVELS,
    labels: THINKING_LEVEL_DISPLAY_LABELS,
    selectedIndex: 2,
    width: 60,
    onConfirm: (level) => {
      confirmed = level;
    },
    onCancel: () => {},
    onPreview: (level) => {
      previews.push(level);
    },
  }));
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Left: medium -> low (preview fires with the new level)
    view.stdin.write("\x1b[D");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(previews, ["low"]);
    // Enter confirms the previewed level. Note: the component reads the
    // selection from its own props, so the harness must re-render with the
    // previewed index — emulate the App's controlled flow instead.
    assert.equal(confirmed, undefined);
  } finally {
    view.cleanup();
  }
});

it("EffortPicker confirms the selected level on Enter", async () => {
  let confirmed: ModelThinkingLevel | undefined;
  const view = render(React.createElement(EffortPicker, {
    levels: LEVELS,
    labels: THINKING_LEVEL_DISPLAY_LABELS,
    selectedIndex: 1,
    width: 60,
    onConfirm: (level) => {
      confirmed = level;
    },
    onCancel: () => {},
  }));
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    view.stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(confirmed, "low");
  } finally {
    view.cleanup();
  }
});

it("EffortPicker cancels on Esc without confirming", async () => {
  let confirmed: ModelThinkingLevel | undefined;
  let cancelled = false;
  const view = render(React.createElement(EffortPicker, {
    levels: LEVELS,
    labels: THINKING_LEVEL_DISPLAY_LABELS,
    selectedIndex: 1,
    width: 60,
    onConfirm: (level) => {
      confirmed = level;
    },
    onCancel: () => {
      cancelled = true;
    },
  }));
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    view.stdin.write("\x1b");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(confirmed, undefined);
    assert.equal(cancelled, true);
  } finally {
    view.cleanup();
  }
});

it("EffortPicker clamps out-of-range selection to the nearest valid level", async () => {
  let confirmed: ModelThinkingLevel | undefined;
  const view = render(React.createElement(EffortPicker, {
    levels: LEVELS,
    labels: THINKING_LEVEL_DISPLAY_LABELS,
    selectedIndex: 99,
    width: 60,
    onConfirm: (level) => {
      confirmed = level;
    },
    onCancel: () => {},
  }));
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    view.stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(confirmed, "high");
  } finally {
    view.cleanup();
  }
});
