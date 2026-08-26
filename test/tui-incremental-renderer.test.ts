import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { IncrementalTerminalRenderer } from "../src/tui/incremental-renderer.ts";

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
});

