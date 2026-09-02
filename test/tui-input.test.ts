import { PassThrough } from "node:stream";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React, { useState } from "react";
import { render } from "ink";
import {
  extractFileAcTrigger,
  parseAtRefs,
  sanitizeInput,
  shouldAcceptAutocompleteOnEnter,
} from "../src/tui/input-utils.ts";
import {
  isPasteShortcut,
  PromptInput,
} from "../src/tui/components/PromptInput.tsx";
import { useAutocomplete } from "../src/tui/hooks/useAutocomplete.ts";
import type { AutocompleteNavKey } from "../src/tui/autocomplete.ts";

const nextFrame = () => new Promise((resolve) => setTimeout(resolve, 25));

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
  it("keeps newlines and tabs while stripping other control characters", () => {
    assert.equal(sanitizeInput("a\nb\tc\u0001d\u0014e\u007Ff"), "a\nb\tcdef");
  });

  it("does not strip Chinese or emoji", () => {
    assert.equal(sanitizeInput("你好😀\n世界"), "你好😀\n世界");
  });

  it("normalizes carriage returns to newlines", () => {
    assert.equal(sanitizeInput("a\r\nb\rc"), "a\nb\nc");
  });

  it("replaces an @fragment without dropping the surrounding prompt", () => {
    const trigger = extractFileAcTrigger("see @src");
    assert.ok(trigger);
    assert.equal(trigger.fragment, "src");
    const replaced = trigger.replaceFn("src/App.tsx");
    assert.equal(replaced.startsWith("see "), true);
    assert.equal(replaced.endsWith("@src/App.tsx"), true);
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

  it("recognizes a bare file fragment for direct completion", () => {
    const trigger = extractFileAcTrigger("app");
    assert.ok(trigger);
    assert.equal(trigger.fragment, "app");
    assert.equal(trigger.replaceFn("src/tui/App.tsx"), "src/tui/App.tsx");
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
    assert.equal(shouldAcceptAutocompleteOnEnter("command"), true);
    assert.equal(shouldAcceptAutocompleteOnEnter("file"), true);
    assert.equal(shouldAcceptAutocompleteOnEnter("model"), true);
    assert.equal(shouldAcceptAutocompleteOnEnter("model-picker"), true);
    assert.equal(shouldAcceptAutocompleteOnEnter("session-list"), true);
    assert.equal(shouldAcceptAutocompleteOnEnter(null), false);
    assert.equal(shouldAcceptAutocompleteOnEnter("model-setup"), false);
    assert.equal(shouldAcceptAutocompleteOnEnter("profile-list"), false);
    assert.equal(shouldAcceptAutocompleteOnEnter("profile-name"), false);
  });
});

describe("PromptInput", () => {
  it("recognizes terminal Ctrl+V without treating plain v as image paste", () => {
    assert.equal(isPasteShortcut("v", { ctrl: true, meta: false }), true);
    assert.equal(isPasteShortcut("\u0016", { ctrl: true, meta: false }), true);
    assert.equal(isPasteShortcut("v", { ctrl: false, meta: false }), false);
  });

  it("types, pastes multiline text, and keeps Ctrl+V out of the value", async () => {
    const { terminalIn, terminalOut } = createTerminal();
    let currentValue = "draft";
    let pasteCount = 0;
    let submitted = "";

    function Harness(): React.ReactElement {
      const [value, setValue] = useState("draft");
      currentValue = value;
      return React.createElement(PromptInput, {
        value,
        onChange: setValue,
        onSubmit: (next) => { submitted = next; },
        onPasteImage: () => { pasteCount += 1; },
      });
    }

    const app = render(React.createElement(Harness), {
      stdin: terminalIn as unknown as NodeJS.ReadStream,
      stdout: terminalOut as unknown as NodeJS.WriteStream,
      stderr: terminalOut as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    try {
      await nextFrame();
      terminalIn.write("x");
      await nextFrame();
      assert.equal(currentValue, "draftx");

      terminalIn.write("hello\nworld\nfoo\nbar");
      await nextFrame();
      assert.equal(currentValue.includes("hello\nworld\nfoo\nbar"), true);

      const beforePaste = currentValue;
      terminalIn.write("\u0016");
      await nextFrame();
      assert.equal(pasteCount, 1);
      assert.equal(currentValue, beforePaste);

      terminalIn.write("\r");
      await nextFrame();
      assert.equal(submitted, currentValue);
    } finally {
      app.unmount();
    }
  });

  it("deletes a Chinese grapheme with backspace", async () => {
    const { terminalIn, terminalOut } = createTerminal();
    let currentValue = "hi";

    function Harness(): React.ReactElement {
      const [value, setValue] = useState("hi");
      currentValue = value;
      return React.createElement(PromptInput, {
        value,
        onChange: setValue,
        onSubmit: () => {},
      });
    }

    const app = render(React.createElement(Harness), {
      stdin: terminalIn as unknown as NodeJS.ReadStream,
      stdout: terminalOut as unknown as NodeJS.WriteStream,
      stderr: terminalOut as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    try {
      await nextFrame();
      terminalIn.write("你");
      await nextFrame();
      assert.equal(currentValue, "hi你");

      terminalIn.write("\x7f");
      await nextFrame();
      assert.equal(currentValue, "hi");
    } finally {
      app.unmount();
    }
  });

  it("ignores keystrokes when unfocused", async () => {
    const { terminalIn, terminalOut } = createTerminal();
    let currentValue = "draft";

    function Harness(): React.ReactElement {
      const [value, setValue] = useState("draft");
      currentValue = value;
      return React.createElement(PromptInput, {
        value,
        onChange: setValue,
        onSubmit: () => {},
        focus: false,
      });
    }

    const app = render(React.createElement(Harness), {
      stdin: terminalIn as unknown as NodeJS.ReadStream,
      stdout: terminalOut as unknown as NodeJS.WriteStream,
      stderr: terminalOut as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    try {
      await nextFrame();
      terminalIn.write("x");
      await nextFrame();
      assert.equal(currentValue, "draft");
    } finally {
      app.unmount();
    }
  });

  it("uses asynchronously loaded session candidates for picker navigation", async () => {
    const { terminalIn, terminalOut } = createTerminal();
    const sessions = [
      { id: "session-one", createdAt: 1, lastActiveAt: 2, messageCount: 1, preview: "one" },
      { id: "session-two", createdAt: 1, lastActiveAt: 1, messageCount: 1, preview: "two" },
    ];
    let listCalls = 0;
    const listSessions = async () => {
      listCalls += 1;
      return sessions;
    };
    let currentValue = "";
    let currentMode: string | null = null;
    let currentIndex = -1;
    let handleKey: ((key: AutocompleteNavKey) => boolean) | undefined;

    function Harness(): React.ReactElement {
      const [value, setValue] = useState("/resume");
      const autocomplete = useAutocomplete({
        input: value,
        cwd: process.cwd(),
        setInput: setValue,
        resetInputCursorToEnd: () => {},
        listSessions,
      });
      currentValue = value;
      currentMode = autocomplete.acMode;
      currentIndex = autocomplete.acIndex;
      handleKey = autocomplete.handleAutocompleteKey;
      return React.createElement(PromptInput, {
        value,
        onChange: setValue,
        onSubmit: () => {},
      });
    }

    const app = render(React.createElement(Harness), {
      stdin: terminalIn as unknown as NodeJS.ReadStream,
      stdout: terminalOut as unknown as NodeJS.WriteStream,
      stderr: terminalOut as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    try {
      await nextFrame();
      assert.equal(currentMode, "session-list");
      assert.equal(currentIndex, 0);
      assert.equal(listCalls, 1, "opening the picker should issue one session listing request");
      assert.equal(handleKey?.({ downArrow: true }), true);
      await nextFrame();
      assert.equal(currentIndex, 1);
      assert.equal(handleKey?.({ tab: true }), true);
      await nextFrame();
      assert.equal(currentValue, "/resume session-two");
    } finally {
      app.unmount();
    }
  });

  it("reuses an in-flight session listing while the same picker command changes", async () => {
    const { terminalIn, terminalOut } = createTerminal();
    const sessions = [
      { id: "session-one", createdAt: 1, lastActiveAt: 2, messageCount: 1, preview: "one" },
    ];
    let listCalls = 0;
    let releaseSessions: ((value: typeof sessions) => void) | undefined;
    const listSessions = () => {
      listCalls += 1;
      return new Promise<typeof sessions>((resolve) => {
        releaseSessions = resolve;
      });
    };
    let changeInput: ((value: string) => void) | undefined;
    let currentMode: string | null = null;
    let currentSessions: typeof sessions = [];

    function Harness(): React.ReactElement {
      const [value, setValue] = useState("/resume");
      changeInput = setValue;
      const autocomplete = useAutocomplete({
        input: value,
        cwd: process.cwd(),
        setInput: setValue,
        resetInputCursorToEnd: () => {},
        listSessions,
      });
      currentMode = autocomplete.acMode;
      currentSessions = autocomplete.sessionCandidates;
      return React.createElement(PromptInput, {
        value,
        onChange: setValue,
        onSubmit: () => {},
      });
    }

    const app = render(React.createElement(Harness), {
      stdin: terminalIn as unknown as NodeJS.ReadStream,
      stdout: terminalOut as unknown as NodeJS.WriteStream,
      stderr: terminalOut as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    try {
      await nextFrame();
      assert.equal(currentMode, "session-list");
      assert.equal(listCalls, 1);

      changeInput?.("/resume ");
      await nextFrame();
      assert.equal(currentMode, "session-list");
      assert.equal(listCalls, 1, "editing the same picker command must reuse its in-flight request");

      releaseSessions?.(sessions);
      await nextFrame();
      assert.deepEqual(currentSessions.map((session) => session.id), ["session-one"]);
    } finally {
      app.unmount();
    }
  });
});
