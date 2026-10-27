import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React from "react";
import { Box, Text } from "ink";
import { render } from "ink-testing-library";
import { Header } from "../src/tui/components/Header.tsx";
import { MessageFeed } from "../src/tui/components/MessageFeed.tsx";
import { PromptInput } from "../src/tui/components/PromptInput.tsx";
import { StatusBar } from "../src/tui/components/StatusBar.tsx";
import { getMessageFeedHeight } from "../src/tui/layout.ts";
import { estimatePromptInputRows } from "../src/tui/components/PromptInput.tsx";

describe("live TUI feed layout", () => {
  it("estimates wrapped and multiline prompt rows", () => {
    assert.equal(estimatePromptInputRows("one\ntwo\nthree", 20), 3);
    assert.equal(estimatePromptInputRows("x".repeat(40), 20), 3);
    assert.equal(estimatePromptInputRows("", 20, "placeholder"), 1);
  });

  it("keeps streamed assistant text above the editable prompt", () => {
    const promptText = "PROMPT_DRAFT_MARKER";
    const streamText = Array.from({ length: 120 }, () => "LLM_STREAM_MARKER").join(" ");
    const view = render(
      React.createElement(
        Box,
        { flexDirection: "column", width: 80, height: 23, overflow: "hidden" },
        React.createElement(Header, { modelName: "test-model", width: 80 }),
        React.createElement(
          Box,
          { flexDirection: "column", flexGrow: 1, flexShrink: 1, minHeight: 0, overflow: "hidden" },
          React.createElement(MessageFeed, {
            messages: [],
            streamingText: streamText,
            busy: false,
            status: "Responding…",
            availableHeight: getMessageFeedHeight({
              termRows: 24,
              inputRows: estimatePromptInputRows(promptText, 76),
            }),
            width: 80,
          }),
        ),
        React.createElement(
          Box,
          { flexDirection: "column", flexShrink: 0 },
          React.createElement(
            Box,
            { paddingX: 1, gap: 1, flexShrink: 0 },
            React.createElement(Text, { bold: true }, ">"),
            React.createElement(
              Box,
              { flexGrow: 1, minWidth: 0 },
              React.createElement(PromptInput, { value: promptText, onChange: () => {}, onSubmit: () => {} }),
            ),
          ),
          React.createElement(StatusBar, {
            modelName: "test-model",
            tokenEstimate: 1,
            contextWindow: 128000,
            busy: false,
            permissionMode: "plan",
            thinkingLevel: "off",
          }),
        ),
      ),
    );

    try {
      const promptRow = (view.lastFrame() ?? "").split("\n").find((line) => line.includes(promptText));
      assert.ok(promptRow, "the prompt should remain visible");
      assert.doesNotMatch(promptRow, /LLM_STREAM_MARKER/, "streamed text must not share the prompt row");
    } finally {
      view.cleanup();
    }
  });
});
