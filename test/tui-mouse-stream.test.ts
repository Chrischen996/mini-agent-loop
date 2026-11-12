import { PassThrough } from "node:stream";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  TerminalInputFilter,
  isMouseEvent,
  parseMouseWheel,
} from "../src/tui/mouse-events.ts";
import { createTerminalStdin } from "../src/tui/terminal-stdin.ts";

const WHEEL_UP = "\x1b[<64;20;8M";
const WHEEL_DOWN = "\x1b[<65;20;8M";

describe("streaming mouse input filter", () => {
  it("keeps a single report atomic", () => {
    const parts = new TerminalInputFilter().push(WHEEL_UP);
    assert.deepEqual(parts, [{ kind: "mouse", wheel: "up" }]);
  });

  it("splits concatenated reports from one fast scroll burst", () => {
    const parts = new TerminalInputFilter().push(WHEEL_UP + WHEEL_UP + WHEEL_DOWN);
    assert.deepEqual(parts, [
      { kind: "mouse", wheel: "up" },
      { kind: "mouse", wheel: "up" },
      { kind: "mouse", wheel: "down" },
    ]);
  });

  it("reassembles a report split across two reads", () => {
    const filter = new TerminalInputFilter();
    assert.deepEqual(filter.push("\x1b[<64;20"), []);
    assert.deepEqual(filter.push(";8M"), [{ kind: "mouse", wheel: "up" }]);
  });

  it("passes normal typing through between reports", () => {
    const parts = new TerminalInputFilter().push(`he你好llo${WHEEL_UP}world`);
    assert.deepEqual(parts, [
      { kind: "text", text: "he你好llo" },
      { kind: "mouse", wheel: "up" },
      { kind: "text", text: "world" },
    ]);
  });

  it("keeps non-wheel SGR reports out of the prompt", () => {
    const parts = new TerminalInputFilter().push("\x1b[<0;3;4M");
    assert.deepEqual(parts, [{ kind: "mouse" }]);
  });

  it("parses X10 wheel reports and splits them too", () => {
    const parts = new TerminalInputFilter().push("\x1b[M`!!\x1b[Ma!!");
    assert.deepEqual(parts, [
      { kind: "mouse", wheel: "up" },
      { kind: "mouse", wheel: "down" },
    ]);
  });

  it("never holds text longer than a report prefix", () => {
    const filter = new TerminalInputFilter();
    const parts = filter.push(`[${"9".repeat(40)};2`);
    // Over-long digit runs cannot be a report: they must stay text.
    assert.ok(parts.every((part) => part.kind === "text"));
  });

  it("does not treat a mid-frame ESC-less bracket as a report", () => {
    const parts = new TerminalInputFilter().push("array[<1] index");
    assert.deepEqual(parts, [{ kind: "text", text: "array[<1] index" }]);
  });

  it("anchors the single-report helpers after the adapter", () => {
    assert.equal(parseMouseWheel(WHEEL_UP), "up");
    assert.equal(isMouseEvent(WHEEL_DOWN), true);
    assert.equal(isMouseEvent("plain"), false);
  });
});

describe("terminal stdin adapter", () => {
  function fakeStdin() {
    return Object.assign(new PassThrough(), {
      setRawMode: () => undefined,
      isRaw: true,
      ref: () => undefined,
      unref: () => undefined,
    }) as unknown as Parameters<typeof createTerminalStdin>[0];
  }

  function collect(adapter: ReturnType<typeof createTerminalStdin>): { reads: string[]; done: Promise<void> } {
    const reads: string[] = [];
    const done = new Promise<void>((resolve) => {
      adapter.on("readable", () => {
        for (let chunk = adapter.read(); chunk !== null; chunk = adapter.read()) {
          reads.push(chunk);
        }
      });
      adapter.on("end", resolve);
    });
    return { reads, done };
  }

  it("emits each concatenated wheel report as its own read", async () => {
    const stdin = fakeStdin();
    const adapter = createTerminalStdin(stdin);
    const { reads, done } = collect(adapter);
    stdin.emit("data", Buffer.from(WHEEL_UP + WHEEL_DOWN + "hi", "utf8"));
    adapter.dispose();
    await done;
    assert.deepEqual(reads, [WHEEL_UP, WHEEL_DOWN, "hi"]);
  });

  it("emits a split report once both halves arrived", async () => {
    const stdin = fakeStdin();
    const adapter = createTerminalStdin(stdin);
    const { reads, done } = collect(adapter);
    stdin.emit("data", Buffer.from("\x1b[<64;20;", "utf8"));
    stdin.emit("data", Buffer.from("8M", "utf8"));
    adapter.dispose();
    await done;
    assert.deepEqual(reads, [WHEEL_UP]);
  });

  it("preserves pasted text and UTF-8 characters unchanged", async () => {
    const stdin = fakeStdin();
    const adapter = createTerminalStdin(stdin);
    const { reads, done } = collect(adapter);
    stdin.emit("data", Buffer.from("你好 world", "utf8"));
    adapter.dispose();
    await done;
    assert.equal(reads.join(""), "你好 world");
  });

  it("forwards every editing and control key the prompt depends on", async () => {
    const stdin = fakeStdin();
    const adapter = createTerminalStdin(stdin);
    const { reads, done } = collect(adapter);
    // Backspace/DEL, Enter, Tab, Ctrl+C, arrows and a bare ESC must all reach
    // Ink; swallowing any of them makes the prompt look frozen.
    const keys = ["\x7f", "\x08", "\r", "\n", "\t", "\x03", "\x1b[A", "\x1b[B", "\x1b"];
    for (const key of keys) stdin.emit("data", Buffer.from(key, "utf8"));
    adapter.dispose();
    await done;
    assert.deepEqual(reads, keys);
  });

  it("keeps typing alive across many sequential reads", async () => {
    const stdin = fakeStdin();
    const adapter = createTerminalStdin(stdin);
    const { reads, done } = collect(adapter);
    for (const char of "hello world") stdin.emit("data", Buffer.from(char, "utf8"));
    adapter.dispose();
    await done;
    assert.equal(reads.join(""), "hello world");
  });

  it("does not stall text after a report was held across reads", async () => {
    const stdin = fakeStdin();
    const adapter = createTerminalStdin(stdin);
    const { reads, done } = collect(adapter);
    stdin.emit("data", Buffer.from("a\x1b[<64;20", "utf8"));
    stdin.emit("data", Buffer.from(";8Mb", "utf8"));
    adapter.dispose();
    await done;
    assert.deepEqual(reads, ["a", WHEEL_UP, "b"]);
  });
});

