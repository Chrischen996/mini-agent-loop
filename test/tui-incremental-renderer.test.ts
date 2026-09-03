import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createIncrementalStdout,
  IncrementalTerminalRenderer,
  resolveTerminalDisplayMode,
  ScrollbackTerminalRenderer,
} from "../src/tui/incremental-renderer.ts";
import { PiTuiFrame } from "../src/tui/pi-tui-frame.ts";

function sink(): { writes: string[]; target: { write(value: string): boolean } } {
  const writes: string[] = [];
  return { writes, target: { write(value: string) { writes.push(value); return true; } } };
}

describe("incremental terminal renderer", () => {
  it("defaults to pi-tui alternate screen with older modes as explicit opt-ins", () => {
    assert.equal(resolveTerminalDisplayMode({}), "pi");
    assert.equal(resolveTerminalDisplayMode({ MINI_AGENT_TUI_MODE: "pi" }), "pi");
    assert.equal(resolveTerminalDisplayMode({ MINI_AGENT_TUI_MODE: "alternate" }), "pi");
    assert.equal(resolveTerminalDisplayMode({ MINI_AGENT_TUI_MODE: "fullscreen" }), "fullscreen");
    assert.equal(resolveTerminalDisplayMode({ MINI_AGENT_TUI_MODE: "main-screen" }), "scrollback");
    assert.equal(resolveTerminalDisplayMode({ MINI_AGENT_TUI_SCROLLBACK: "1" }), "scrollback");
    assert.equal(resolveTerminalDisplayMode({ MINI_AGENT_TUI_FULLSCREEN: "1" }), "fullscreen");
    assert.equal(resolveTerminalDisplayMode({ MINI_AGENT_TUI_SCROLLBACK: "0" }), "fullscreen");
  });

  it("adapts shared RenderLine rows to pi-tui's width and height contract", () => {
    const input: string[] = [];
    const frame = new PiTuiFrame(
      { rows: 5 },
      () => [
        { key: "one", text: "one", style: "assistant" },
        { key: "long", text: "0123456789", style: "assistant" },
      ],
      (data) => input.push(data),
    );

    assert.equal(frame.render(5).length, 2);
    assert.ok(frame.render(5).every((line) => line.replace(/\x1b\[[0-9;]*m/g, "").length <= 5));
    frame.handleInput("x");
    assert.deepEqual(input, ["x"]);
  });

  it("appends committed transcript rows and redraws only the live tail", () => {
    const output = sink();
    const renderer = new ScrollbackTerminalRenderer(output.target);

    renderer.renderLines([
      { key: "history-1", text: "first message", style: "assistant" },
      { key: "status", text: "Working…", style: "muted", ephemeral: true },
      { key: "input", text: "▌", style: "assistant", ephemeral: true },
    ]);
    assert.match(output.writes[0]!, /first message/);
    output.writes.length = 0;

    renderer.renderLines([
      { key: "history-1", text: "first message", style: "assistant" },
      { key: "history-2", text: "second message", style: "assistant" },
      { key: "status", text: "Ready", style: "muted", ephemeral: true },
      { key: "input", text: "next▌", style: "assistant", ephemeral: true },
    ]);

    const update = output.writes[0]!;
    assert.match(update, /second message/);
    assert.match(update, /Ready/);
    assert.match(update, /next▌/);
    assert.doesNotMatch(update, /first message/);
    assert.match(update, /\x1b\[2A/);
    assert.doesNotMatch(update, /\x1b\[2J/);
  });

  it("keeps scrollback rows untouched when only the prompt changes", () => {
    const output = sink();
    const renderer = new ScrollbackTerminalRenderer(output.target);

    renderer.renderLines([
      { key: "history", text: "committed", style: "assistant" },
      { key: "input", text: "a▌", style: "assistant", ephemeral: true },
    ]);
    output.writes.length = 0;
    renderer.renderLines([
      { key: "history", text: "committed", style: "assistant" },
      { key: "input", text: "ab▌", style: "assistant", ephemeral: true },
    ]);

    assert.match(output.writes[0]!, /ab▌/);
    assert.doesNotMatch(output.writes[0]!, /committed/);
  });

  it("skips a scrollback frame when both history and live tail are unchanged", () => {
    const output = sink();
    const renderer = new ScrollbackTerminalRenderer(output.target);
    const frame = [
      { key: "history", text: "committed", style: "assistant" as const },
      { key: "input", text: "▌", style: "assistant" as const, ephemeral: true },
    ];

    renderer.renderLines(frame);
    output.writes.length = 0;
    renderer.renderLines(frame);

    assert.deepEqual(output.writes, []);
  });

  it("returns control to the shell without leaving an alternate-screen escape", () => {
    const output = sink();
    const renderer = new ScrollbackTerminalRenderer(output.target);
    renderer.renderLines([
      { key: "status", text: "Working", style: "muted", ephemeral: true },
      { key: "input", text: "ready", style: "assistant", ephemeral: true },
    ]);
    output.writes.length = 0;

    renderer.finish();

    assert.match(output.writes[0]!, /\x1b\[2A/);
    assert.match(output.writes[0]!, /\x1b\[2K/);
    assert.doesNotMatch(output.writes[0]!, /Working|ready/);
    assert.match(output.writes[0]!, /\x1b\[\?25h/);
    assert.doesNotMatch(output.writes[0]!, /\x1b\[\?1049[hl]/);
  });

  it("keeps the cursor at the live-tail origin when ephemeral rows shrink", () => {
    const output = sink();
    const renderer = new ScrollbackTerminalRenderer(output.target);

    renderer.renderLines([
      { key: "history", text: "committed", style: "assistant" },
      { key: "status", text: "Working", style: "muted", ephemeral: true },
      { key: "completion", text: "50%", style: "muted", ephemeral: true },
      { key: "input", text: "a", style: "assistant", ephemeral: true },
    ]);
    output.writes.length = 0;

    renderer.renderLines([
      { key: "history", text: "committed", style: "assistant" },
      { key: "status", text: "Ready", style: "muted", ephemeral: true },
    ]);

    const update = output.writes[0]!;
    assert.match(update, /\x1b\[3A/);
    assert.match(update, /\x1b\[2A/);
    assert.match(update, /Ready/);
    assert.doesNotMatch(update, /committed/);
  });

  it("starts a new append-only segment when committed history is reset", () => {
    const output = sink();
    const renderer = new ScrollbackTerminalRenderer(output.target);

    renderer.renderLines([
      { key: "history-1", text: "old conversation", style: "assistant" },
      { key: "input", text: "", style: "assistant", ephemeral: true },
    ]);
    output.writes.length = 0;

    renderer.renderLines([
      { key: "history-2", text: "new conversation", style: "assistant" },
      { key: "input", text: "", style: "assistant", ephemeral: true },
    ]);

    const update = output.writes[0]!;
    assert.match(update, /new conversation/);
    assert.match(update, /\n\n/);
    assert.doesNotMatch(update, /old conversation/);
  });

  it("updates only changed rows and skips identical frames", () => {
    const output = sink();
    const renderer = new IncrementalTerminalRenderer(output.target as never);

    renderer.write("one\ntwo\n");
    output.writes.length = 0;
    renderer.write("one\nchanged\n");

    assert.equal(output.writes.length, 1);
    assert.match(output.writes[0]!, /2;1H/);
    assert.match(output.writes[0]!, /changed/);

    output.writes.length = 0;
    renderer.write("one\nchanged\n");
    assert.deepEqual(output.writes, []);
  });

  it("clears rows left behind by a shorter frame", () => {
    const output = sink();
    const renderer = new IncrementalTerminalRenderer(output.target as never);

    renderer.write("one\ntwo\nthree\n");
    output.writes.length = 0;
    renderer.write("one\n");

    assert.equal(output.writes.length, 1);
    assert.match(output.writes[0]!, /2;1H/);
    assert.match(output.writes[0]!, /3;1H/);
    assert.match(output.writes[0]!, /\x1b\[2K/);
  });

  it("consumes shared RenderLine models directly", () => {
    const output = sink();
    const renderer = new IncrementalTerminalRenderer(output.target as never);
    renderer.renderLines([{ key: "todo", text: "TODO 1/2", style: "todo", bold: true }]);
    assert.equal(output.writes.length, 1);
    assert.match(output.writes[0]!, /TODO 1\/2/);
    output.writes.length = 0;
    renderer.renderLines([{ key: "todo", text: "TODO 1/2", style: "todo", bold: true }]);
    assert.deepEqual(output.writes, []);
  });

  it("formats Claude-style backgrounds and italic thinking labels", () => {
    const output = sink();
    const renderer = new IncrementalTerminalRenderer(output.target as never);

    renderer.renderLines([
      { key: "user", text: "hello", prefix: "❯ ", style: "user", background: "user", fillWidth: 12 },
      { key: "thinking", text: "∴ Thinking…", style: "thinking", italic: true, dim: true },
    ]);

    assert.match(output.writes[0]!, /48;5;236/);
    assert.match(output.writes[0]!, /hello {3}/);
    assert.match(output.writes[0]!, /3;2;38;2;175;135;255/);
  });

  it("converts Ink clearTerminal and eraseLines prefixes without full-screen clears", () => {
    const output = sink();
    const renderer = new IncrementalTerminalRenderer(output.target as never);

    renderer.write("\x1b[2J\x1b[3J\x1b[Hone\ntwo");
    assert.ok(output.writes[0]?.includes("one"));
    assert.ok(!output.writes[0]?.includes("\x1b[2J"));

    output.writes.length = 0;
    renderer.write("\x1b[2K\x1b[1A\x1b[2K\x1b[Gone\nchanged");
    assert.ok(output.writes[0]?.includes("changed"));
    assert.ok(!output.writes[0]?.includes("\x1b[G"));
  });

  it("turns a clear-only Ink frame into row erases", () => {
    const output = sink();
    const renderer = new IncrementalTerminalRenderer(output.target as never);
    renderer.write("one\ntwo");
    output.writes.length = 0;

    renderer.write("\x1b[2J\x1b[3J\x1b[H");
    assert.equal(output.writes.length, 1);
    assert.ok(output.writes[0]?.includes("\x1b[2K"));
    assert.ok(!output.writes[0]?.includes("\x1b[2J"));
  });

  it("preserves WriteStream dimensions through the Ink facade", () => {
    const writes: string[] = [];
    const target = {
      rows: 24,
      columns: 80,
      isTTY: true,
      write(value: string) {
        writes.push(value);
        return true;
      },
    };
    const facade = createIncrementalStdout(target as never);

    assert.equal(facade.rows, 24);
    assert.equal(facade.columns, 80);
    facade.write("hello\nworld");
    assert.ok(writes.some((value) => value.includes("hello")));
  });
});
