import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { osc52Payload, writeClipboardText } from "../src/tui/clipboard.ts";
import {
  extractMessageCopyText,
  formatCopyResultNotice,
  parseCopyCommand,
  resolveCopyTarget,
} from "../src/tui/copy-text.ts";
import { SLASH_COMMANDS } from "../src/tui/components/FileAutocomplete.tsx";
import type { ChatMessage } from "../src/tui/state.ts";

const messages: ChatMessage[] = [
  { kind: "user", text: "line one\nline two", displayText: "[已折叠 2 行 / 17 字]" },
  { kind: "assistant", text: "## 结论\n**重要**", reasoning: "hidden reasoning" },
  { kind: "tool_call", id: "1", name: "bash", args: "{}", rawArgs: { command: "ls" }, status: "done", result: "alpha\nbeta\ngamma", startedAt: 1 },
];

describe("TUI copy helpers", () => {
  it("parses /copy commands", () => {
    assert.equal(parseCopyCommand("/copy"), "auto");
    assert.equal(parseCopyCommand("/copy last"), "auto");
    assert.equal(parseCopyCommand("/copy assistant"), "assistant");
    assert.equal(parseCopyCommand("/copy tool"), "tool");
    assert.equal(parseCopyCommand("/copy thinking"), "thinking");
    assert.equal(parseCopyCommand("/copy input"), "input");
    assert.equal(parseCopyCommand("/help"), undefined);
  });

  it("copies raw assistant text instead of the decorated display", () => {
    const selection = resolveCopyTarget({ messages, target: "assistant" });
    assert.equal(selection?.text, "## 结论\n**重要**");
    assert.doesNotMatch(selection?.text ?? "", /━━━|【重要】/);
  });

  it("copies the original user prompt, not the collapsed summary", () => {
    const selection = resolveCopyTarget({ messages, target: "user" });
    assert.equal(selection?.text, "line one\nline two");
    assert.doesNotMatch(selection?.text ?? "", /已复制|已折叠/);
  });

  it("copies full tool output instead of the preview window", () => {
    const selection = resolveCopyTarget({ messages, target: "tool" });
    assert.equal(selection?.label, "bash 输出");
    assert.equal(selection?.text, "alpha\nbeta\ngamma");
  });

  it("prefers the focused message, then the latest assistant reply", () => {
    const focused = resolveCopyTarget({ messages, focusedIndex: 2 });
    assert.equal(focused?.text, "alpha\nbeta\ngamma");
    const auto = resolveCopyTarget({ messages });
    assert.equal(auto?.text, "## 结论\n**重要**");
  });

  it("extracts thinking separately from the visible answer", () => {
    assert.equal(extractMessageCopyText(messages[1]!, "thinking"), "hidden reasoning");
    const selection = resolveCopyTarget({ messages, target: "thinking" });
    assert.equal(selection?.text, "hidden reasoning");
  });

  it("falls back to OSC 52 when native clipboard commands fail", async () => {
    const writes: string[] = [];
    const result = await writeClipboardText("hello", {
      platform: "linux",
      env: {},
      run: async () => {
        throw new Error("missing");
      },
      writeStdout: (data) => {
        writes.push(data);
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.method, "osc52");
    assert.equal(writes[0], osc52Payload("hello"));
  });

  it("uses pbcopy on macOS when the helper succeeds", async () => {
    const seen: Array<{ command: string; input: string }> = [];
    const result = await writeClipboardText("payload", {
      platform: "darwin",
      run: async (command, _args, input) => {
        seen.push({ command, input });
      },
      writeStdout: () => {
        throw new Error("osc52 should not run");
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.method, "pbcopy");
    assert.deepEqual(seen, [{ command: "pbcopy", input: "payload" }]);
  });

  it("formats a copy notice with line and character counts", () => {
    assert.equal(
      formatCopyResultNotice({ label: "助手回复", text: "ab\ncd" }, "pbcopy"),
      "助手回复 · 2 行 / 5 字 · pbcopy",
    );
  });

  it("registers /copy before help", () => {
    const names = SLASH_COMMANDS.map((command) => command.name);
    assert.ok(names.includes("copy"));
    assert.ok(names.indexOf("copy") < names.indexOf("help"));
  });
});
