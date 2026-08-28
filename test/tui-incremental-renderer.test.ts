import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createIncrementalStdout, IncrementalTerminalRenderer } from "../src/tui/incremental-renderer.ts";

function sink(): { writes: string[]; target: { write(value: string): boolean } } {
  const writes: string[] = [];
  return { writes, target: { write(value: string) { writes.push(value); return true; } } };
}

describe("incremental terminal renderer", () => {
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
