import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EventEmitter } from "node:events";
import {
  createIncrementalStdout,
  IncrementalTerminalRenderer,
} from "../src/tui/incremental-renderer.ts";
import { disableMouseTracking, enableMouseTracking } from "../src/tui/mouse-tracking.ts";
import { isSgrMouseEvent, parseSgrMouseWheel } from "../src/tui/mouse-events.ts";

function sink(): { writes: string[]; target: EventEmitter & { write(value: string): boolean } } {
  const writes: string[] = [];
  const target = new EventEmitter() as EventEmitter & { write(value: string): boolean };
  target.write = (value) => { writes.push(value); return true; };
  return { writes, target };
}

describe("incremental terminal renderer", () => {
  it("uses reversible terminal mouse-tracking sequences for alternate-screen scrolling", () => {
    const writes: string[] = [];
    const target = { write(value: string) { writes.push(value); return true; } };

    enableMouseTracking(target);
    disableMouseTracking(target);

    assert.deepEqual(writes, ["\x1b[?1000h\x1b[?1006h", "\x1b[?1006l\x1b[?1000l"]);
  });

  it("recognizes SGR mouse reports in both raw and ESC-stripped form", () => {
    assert.equal(parseSgrMouseWheel("\x1b[<64;20;8M"), "up");
    assert.equal(parseSgrMouseWheel("\x1b[<65;20;8M"), "down");
    assert.equal(parseSgrMouseWheel("\x1b[<0;20;8M"), undefined);
    // Ink strips the leading ESC before its useInput handlers run.
    assert.equal(isSgrMouseEvent("\x1b[<64;20;8M"), true);
    assert.equal(isSgrMouseEvent("[<64;20;8M"), true);
    assert.equal(isSgrMouseEvent("[<0;20;8M"), true);
    assert.equal(isSgrMouseEvent("[<64;20;"), false);
    assert.equal(isSgrMouseEvent("plain text"), false);
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

  it("redraws unchanged rows after Ink requests a terminal clear", () => {
    const output = sink();
    const renderer = new IncrementalTerminalRenderer(output.target as never);

    renderer.write("header\ntranscript\nfooter");
    output.writes.length = 0;
    renderer.write("\x1b[2J\x1b[3J\x1b[Hheader\ntranscript\nfooter");

    assert.equal(output.writes.length, 1);
    assert.match(output.writes[0]!, /1;1H.*header/);
    assert.match(output.writes[0]!, /2;1H.*transcript/);
    assert.match(output.writes[0]!, /3;1H.*footer/);
    assert.ok(!output.writes[0]?.includes("\x1b[2J"));
  });

  it("redraws unchanged rows after a terminal resize", () => {
    const output = sink();
    const facade = createIncrementalStdout(output.target as never);

    facade.write("header\ntranscript\nfooter");
    output.writes.length = 0;
    output.target.emit("resize");
    facade.write("header\ntranscript\nfooter");

    assert.equal(output.writes.length, 1);
    assert.match(output.writes[0]!, /1;1H.*header/);
    assert.match(output.writes[0]!, /2;1H.*transcript/);
    assert.match(output.writes[0]!, /3;1H.*footer/);
  });

  it("keeps SGR escape bytes so styled rows are not painted as literal text", () => {
    const output = sink();
    const renderer = new IncrementalTerminalRenderer(output.target as never);

    renderer.write("\x1b[1m\x1b[38;5;231mmini-agent\x1b[39m\x1b[22m plain\n");

    const frame = output.writes.join("");
    assert.ok(frame.includes("\x1b[1m"), "bold escape must survive");
    assert.ok(frame.includes("\x1b[38;5;231m"), "256-color escape must survive");
    // The regression: stripping ESC turned `ESC[38;5;231m` into visible text.
    assert.ok(!/[^\x1b]\[38;5;231m/.test(frame), "no literal escape text may leak");
  });

  it("still strips real control characters from painted rows", () => {
    const output = sink();
    const renderer = new IncrementalTerminalRenderer(output.target as never);

    renderer.write("a\u0000b\u0007c\u001bd\n");

    const frame = output.writes.join("");
    assert.ok(frame.includes("abcd"));
  });

  it("preserves WriteStream dimensions through the Ink facade", () => {
    const writes: string[] = [];
    const target = Object.assign(new EventEmitter(), {
      rows: 24,
      columns: 80,
      isTTY: true,
      write(value: string) {
        writes.push(value);
        return true;
      },
    });
    const facade = createIncrementalStdout(target as never);

    assert.equal(facade.rows, 24);
    assert.equal(facade.columns, 80);
    facade.write("hello\nworld");
    assert.ok(writes.some((value) => value.includes("hello")));
  });
});

describe("incremental renderer inline mode", () => {
  function sizedSink(rows: number, columns = 40) {
    const writes: string[] = [];
    const target = {
      rows,
      columns,
      write(value: string) {
        writes.push(value);
        return true;
      },
    };
    return { writes, target };
  }

  it("anchors the first inline frame at the screen bottom", () => {
    const output = sizedSink(10);
    const renderer = new IncrementalTerminalRenderer(output.target as never, { mode: "inline" });

    renderer.write("a\nb\nc");

    const painted = output.writes.join("");
    assert.match(painted, /\x1b\[8;1H\x1b\[2Ka/);
    assert.match(painted, /\x1b\[9;1H\x1b\[2Kb/);
    assert.match(painted, /\x1b\[10;1H\x1b\[2Kc/);
    assert.ok(!painted.includes("\x1b[7;1H"), "rows above the anchor stay untouched");
  });

  it("erases the frame region and repaints the frame below a static burst", () => {
    const output = sizedSink(10);
    const renderer = new IncrementalTerminalRenderer(output.target as never, { mode: "inline" });
    renderer.write("a\nb\nc");
    output.writes.length = 0;

    renderer.emitStaticBurst("hello\n");
    const painted = output.writes.join("");
    // Old frame region erased, burst printed at the anchor...
    assert.match(painted, /\x1b\[8;1H\x1b\[2K/);
    assert.match(painted, /\x1b\[10;1H\x1b\[2K/);
    assert.ok(painted.includes("\x1b[8;1Hhello\n"));
    // ...and the dynamic frame repainted below the burst (anchor advanced
    // past one emitted line, then deficit-scrolled by one to fit 3 rows).
    assert.ok(output.writes.some((value) => value.startsWith("\x1b[10;1H\n")), "deficit scroll at the bottom row");
    assert.match(painted, /\x1b\[8;1H\x1b\[2Ka/);
    assert.match(painted, /\x1b\[9;1H\x1b\[2Kb/);
    assert.match(painted, /\x1b\[10;1H\x1b\[2Kc/);

    // A following frame diffs against the repainted baseline.
    output.writes.length = 0;
    renderer.write("a\nb\nx\n");
    const next = output.writes.join("");
    assert.match(next, /\x1b\[10;1H\x1b\[2Kx/);
    assert.ok(!next.includes("b"), "unchanged rows are not rewritten");
  });

  it("scrolls the deficit so an overflowing frame fits below static bursts", () => {
    const output = sizedSink(4);
    const renderer = new IncrementalTerminalRenderer(output.target as never, { mode: "inline" });
    renderer.write("a\nb");
    output.writes.length = 0;

    // The burst advances the anchor past the screen bottom; the repaint
    // deficit-scrolls so the frame stays fully on screen.
    renderer.emitStaticBurst("s1\ns2\ns3\n");
    assert.ok(output.writes.some((value) => value.includes("s1\ns2\ns3\n")), "burst written raw at the anchor");
    assert.ok(output.writes.some((value) => value.startsWith("\x1b[4;1H\n")), "repaint deficit scroll");

    output.writes.length = 0;
    renderer.write("x\ny\nz\n");
    const painted = output.writes.join("");
    assert.match(painted, /\x1b\[2;1H\x1b\[2Kx/);
    assert.match(painted, /\x1b\[3;1H\x1b\[2Ky/);
    assert.match(painted, /\x1b\[4;1H\x1b\[2Kz/);
  });

  it("blanks the screen for a burst emitted before the first frame", () => {
    const output = sizedSink(10);
    const renderer = new IncrementalTerminalRenderer(output.target as never, { mode: "inline" });

    // Unknown anchor (e.g. resumed session): the burst flows into scrollback,
    // then the screen clears so the first frame anchors on a clean surface.
    renderer.emitStaticBurst("blob\n");
    assert.equal(output.writes[0], "\x1b[10;1H\nblob\n");
    assert.equal(output.writes[1], `\x1b[10;1H${"\n".repeat(10)}`);

    output.writes.length = 0;
    renderer.write("a\nb\n");
    const painted = output.writes.join("");
    assert.match(painted, /\x1b\[9;1H\x1b\[2Ka/, "first frame bottom-anchors on the clean screen");
    assert.match(painted, /\x1b\[10;1H\x1b\[2Kb/);
  });

  it("skips unchanged rows and clears rows left by a shorter frame", () => {
    const output = sizedSink(10);
    const renderer = new IncrementalTerminalRenderer(output.target as never, { mode: "inline" });
    renderer.write("a\nb\nc");
    output.writes.length = 0;

    renderer.write("a\nb\nc");
    assert.deepEqual(output.writes, [], "identical frame at the same anchor repaints nothing");

    renderer.write("a\n");
    const painted = output.writes.join("");
    assert.match(painted, /\x1b\[9;1H\x1b\[2K/);
    assert.match(painted, /\x1b\[10;1H\x1b\[2K/);
    assert.ok(!painted.includes("a\n"), "unchanged first row is not rewritten");
  });

  it("clearScreen wipes the visible screen and repaints the frame below", () => {
    const output = sizedSink(10);
    const renderer = new IncrementalTerminalRenderer(output.target as never, { mode: "inline" });
    renderer.write("a\nb\nc");
    renderer.write("a\nb\nx");
    output.writes.length = 0;

    renderer.clearScreen();
    const cleared = output.writes.join("");
    assert.ok(cleared.includes("\x1b[2J\x1b[H"), "clear screen then home");
    assert.match(cleared, /\x1b\[8;1H\x1b\[2Ka/);
    assert.match(cleared, /\x1b\[9;1H\x1b\[2Kb/);
    assert.match(cleared, /\x1b\[10;1H\x1b\[2Kx/);

    // The repaint becomes the diff baseline again: unchanged frames write nothing.
    output.writes.length = 0;
    renderer.write("a\nb\nx\n");
    assert.deepEqual(output.writes, [], "post-clear frames diff against the repainted baseline");
  });

  it("keeps the legacy trailing-newline-as-frame behavior in alternate mode", () => {
    const output = sizedSink(10);
    const renderer = new IncrementalTerminalRenderer(output.target as never, { mode: "alternate" });

    renderer.write("one\ntwo\n");
    const painted = output.writes.join("");
    assert.match(painted, /\x1b\[1;1H\x1b\[2Kone/, "alternate mode top-anchors bare writes as frames");
    assert.match(painted, /\x1b\[2;1H\x1b\[2Ktwo/);
  });
});

