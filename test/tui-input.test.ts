import { PassThrough } from "node:stream";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractFileAcTrigger,
  parseAtRefs,
  sanitizeInput,
  shouldAcceptAutocompleteOnEnter,
} from "../src/tui/input-utils.ts";
import { TerminalInputHistory } from "../src/tui/terminal-input-history.ts";
import type { AcMode } from "../src/tui/input-utils.ts";
import type { AutocompleteNavKey } from "../src/tui/autocomplete.ts";
import type { ResumeMessageCandidate } from "../src/tui/session-serialization.ts";
import {
  lineBounds,
  moveToLineEnd,
  moveToLineStart,
  moveWordLeft,
  moveWordRight,
  splitGraphemes,
} from "../src/tui/input-editing.ts";
import { inputContainerBorderColor, useClaudeStyleInput } from "../src/tui/input-container.ts";
import { TUI_COLORS as C } from "../src/tui/theme.ts";

const nextFrame = () => new Promise((resolve) => setTimeout(resolve, 25));

// ── Pure utility stubs (extracted from deleted Ink components/hooks) ────────
function isPasteShortcut(input: string, key?: { ctrl?: boolean; meta?: boolean }): boolean {
  return Boolean((key?.ctrl || key?.meta) && (input === "v" || input === "V" || input === "\u0016"));
}

function shouldExitOnCtrlC(input: string, key: { ctrl?: boolean; shift?: boolean }): boolean {
  return Boolean(key.ctrl && !key.shift && (input === "c" || input === "C"));
}

function createTerminal() {
  const terminalIn = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: () => terminalIn,
    ref: () => terminalIn,
    unref: () => terminalIn,
  });
  const terminalOut = Object.assign(new PassThrough(), {
    isTTY: true,
    columns: 80,
    rows: 24,
  });
  return { terminalIn, terminalOut };
}

describe("TUI input utils", () => {
  it("does not treat Ctrl+Shift+C as the exit shortcut", () => {
    assert.equal(shouldExitOnCtrlC("c", { ctrl: true, shift: true }), false);
    assert.equal(shouldExitOnCtrlC("c", { ctrl: true, shift: false }), true);
  });

  it("keeps newlines and tabs while stripping other control characters", () => {
    assert.equal(sanitizeInput("a\nb\tc\u0001d\u0014e\u007Ff"), "a\nb\tcdef");
  });

  it("does not strip Chinese or emoji", () => {
    assert.equal(sanitizeInput("你好😀\n世界"), "你好😀\n世界");
  });

  it("keeps emoji and combining characters as single editable graphemes", () => {
    assert.deepEqual(splitGraphemes("a你😀e\u0301"), ["a", "你", "😀", "e\u0301"]);
    assert.deepEqual(splitGraphemes("A👨‍👩‍👧‍👦B"), ["A", "👨‍👩‍👧‍👦", "B"]);
  });

  it("moves Home and End within the current logical line", () => {
    const parts = splitGraphemes("ab\n你😀z\nxy");
    const middleLineCursor = 5;

    assert.deepEqual(lineBounds(parts, middleLineCursor), { start: 3, end: 6 });
    assert.equal(moveToLineStart(parts, middleLineCursor), 3);
    assert.equal(moveToLineEnd(parts, middleLineCursor), 6);
    assert.equal(moveToLineStart(parts, 7), 7);
    assert.equal(moveToLineEnd(parts, 7), 9);
  });

  it("moves between whitespace-delimited words without splitting graphemes", () => {
    const parts = splitGraphemes("one  你😀-two\nthree");

    assert.equal(moveWordRight(parts, 0), 5);
    assert.equal(moveWordRight(parts, 5), 12);
    assert.equal(moveWordRight(parts, 12), parts.length);
    assert.equal(moveWordLeft(parts, parts.length), 12);
    assert.equal(moveWordLeft(parts, 12), 5);
    assert.equal(moveWordLeft(parts, 5), 0);
  });

  it("enables the Claude-style input only for an explicit feature flag", () => {
    assert.equal(useClaudeStyleInput({ TUI_CLAUDE_STYLE_INPUT: "1" }), true);
    assert.equal(useClaudeStyleInput({ TUI_CLAUDE_STYLE_INPUT: "true" }), false);
    assert.equal(useClaudeStyleInput({}), false);
  });

  it("uses semantic input border colors with urgent states first", () => {
    assert.equal(inputContainerBorderColor({ permissionMode: "plan", busy: false, pendingPermission: false }), C.planMode);
    assert.equal(inputContainerBorderColor({ permissionMode: "bypass", busy: true, pendingPermission: false }), C.running);
    assert.equal(inputContainerBorderColor({ permissionMode: "plan", busy: true, pendingPermission: true }), C.error);
    assert.equal(inputContainerBorderColor({ permissionMode: "bypass", busy: false, pendingPermission: false }), C.border);
  });

  it("normalizes carriage returns to newlines", () => {
    assert.equal(sanitizeInput("a\r\nb\rc"), "a\nb\nc");
  });

  it("replaces an @fragment without dropping the surrounding prompt", () => {
    const trigger = extractFileAcTrigger("see @src");
    assert.ok(trigger);
    assert.equal(trigger.fragment, "src");
    const replaced = trigger.replaceFn("src/App.tsx");
    assert.ok(replaced.startsWith("see "));
    assert.ok(replaced.endsWith("@src/App.tsx"));
  });

  it("recognizes Chinese and spaced file fragments", () => {
    const chinese = extractFileAcTrigger("@中文.md");
    assert.ok(chinese);
    assert.equal(chinese.fragment, "中文.md");

    const spaced = extractFileAcTrigger("@foo bar.ts");
    assert.ok(spaced);
    assert.equal(spaced.fragment, "foo bar.ts");
  });

  it("updates only the path after a slash command", () => {
    const trigger = extractFileAcTrigger("/read src");
    assert.ok(trigger);
    assert.equal(trigger.fragment, "src");
    assert.equal(trigger.replaceFn("src/App.tsx"), "/read src/App.tsx");
  });

  it("does not trigger file completion for a bare English word without path indicator", () => {
    const trigger = extractFileAcTrigger("app");
    assert.equal(trigger, null);
  });

  it("recognizes a bare fragment that contains a path indicator", () => {
    const trigger = extractFileAcTrigger("src/app");
    assert.ok(trigger);
    assert.equal(trigger.fragment, "src/app");
    assert.equal(trigger.replaceFn("src/tui/App.tsx"), "src/tui/App.tsx");
  });

  it("does not trigger file completion for version strings or filenames without path separators", () => {
    assert.equal(extractFileAcTrigger("v1.2.3"), null);
    assert.equal(extractFileAcTrigger("package.json"), null);
    assert.equal(extractFileAcTrigger("README.md"), null);
    assert.equal(extractFileAcTrigger("hello.world"), null);
  });

  it("triggers file completion for relative paths starting with ./ or ../", () => {
    const trigger1 = extractFileAcTrigger("./src/app");
    assert.ok(trigger1);
    assert.equal(trigger1.fragment, "./src/app");

    const trigger2 = extractFileAcTrigger("../lib/utils");
    assert.ok(trigger2);
    assert.equal(trigger2.fragment, "../lib/utils");
  });

  it("collects multiple @refs including Chinese and spaced names", () => {
    assert.deepEqual(
      parseAtRefs("see @中文.md and @foo bar.ts"),
      ["中文.md", "foo bar.ts"],
    );
  });

  it("skips email-like tokens when collecting @refs", () => {
    assert.deepEqual(parseAtRefs("email me@host.com and @src/a.ts"), ["src/a.ts"]);
  });

  it("accepts Enter only for list-style autocomplete modes", () => {
    assert.equal(shouldAcceptAutocompleteOnEnter("command" as AcMode), true);
    assert.equal(shouldAcceptAutocompleteOnEnter("file" as AcMode), true);
    assert.equal(shouldAcceptAutocompleteOnEnter("model" as AcMode), true);
    assert.equal(shouldAcceptAutocompleteOnEnter("model-picker" as AcMode), true);
    assert.equal(shouldAcceptAutocompleteOnEnter("session-list" as AcMode), true);
    assert.equal(shouldAcceptAutocompleteOnEnter(null as unknown as AcMode), false);
    assert.equal(shouldAcceptAutocompleteOnEnter("model-setup" as AcMode), false);
    assert.equal(shouldAcceptAutocompleteOnEnter("profile-list" as AcMode), false);
    assert.equal(shouldAcceptAutocompleteOnEnter("profile-name" as AcMode), false);
  });
});
