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
  it("paints flow frames at the cursor instead of a primed absolute row", () => {
    const output = sink();
    const renderer = new IncrementalTerminalRenderer(output.target as never, { mode: "document" });
    renderer.setInitialAnchor(5);
    renderer.write("frame line one\nframe line two\n");
    const painted = output.writes.join("");
    assert.ok(painted.includes("frame line one"));
    assert.doesNotMatch(painted, /\x1b\[5;1H/, "no absolute row is addressed");
    assert.doesNotMatch(painted, /\x1b\[23;1H/, "no bottom-anchored placement");
  });

  it("ignores a cursor prime once the frame has painted", () => {
    const output = sink();
    const renderer = new IncrementalTerminalRenderer(output.target as never, { mode: "document" });
    renderer.write("one\n");
    const before = output.writes.length;
    renderer.setInitialAnchor(3);
    renderer.write("one\ntwo\n");
    const painted = output.writes.slice(before).join("");
    assert.ok(painted.includes("two"));
    assert.doesNotMatch(painted, /\x1b\[\d+;1H/, "relative addressing only");
  });


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

describe("incremental renderer flow mode (inline/document)", () => {
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

  // The invariant that fixes the "composer/status bar duplicated over the
  // history" corruption: flow paints must never address an absolute row,
  // because that is a VIEWPORT row and the user may have scrolled back.
  /** Paint text with per-row erase codes removed (rows are still separated by \\n). */
  function visibleText(writes: readonly string[]): string {
    return writes.join("").split("\x1b[2K").join("");
  }

  function assertNoAbsoluteRows(writes: readonly string[]) {
    for (const value of writes) {
      assert.doesNotMatch(value, /\x1b\[\d+;1H/, `absolute row write: ${JSON.stringify(value)}`);
    }
  }

  it("paints the first flow frame with relative cursor moves only", () => {
    const output = sizedSink(10);
    const renderer = new IncrementalTerminalRenderer(output.target as never, { mode: "inline" });

    renderer.write("a\nb\nc");

    const painted = output.writes.join("");
    assertNoAbsoluteRows(output.writes);
    assert.ok(visibleText(output.writes).includes("a\nb\nc"), "frame rows are written in order");
    assert.ok(painted.endsWith("\x1b[?7h"), "autowrap is restored after the paint");
  });

  it("never addresses absolute rows when the frame is repainted", () => {
    const output = sizedSink(10);
    const renderer = new IncrementalTerminalRenderer(output.target as never, { mode: "document" });
    renderer.write("a\nb\nc");
    output.writes.length = 0;

    renderer.write("a\nchanged\nc");

    assertNoAbsoluteRows(output.writes);
    assert.ok(output.writes.join("").includes("changed"));
  });

  it("erases the previously painted block before rewriting it", () => {
    const output = sizedSink(10);
    const renderer = new IncrementalTerminalRenderer(output.target as never, { mode: "inline" });
    renderer.write("a\nb\nc");
    output.writes.length = 0;

    renderer.write("a\nb\nx");

    const painted = output.writes.join("");
    assertNoAbsoluteRows(output.writes);
    // Three painted lines + the cursor line below them.
    assert.ok(painted.includes("\x1b[2K\x1b[1A\x1b[2K\x1b[1A\x1b[2K\x1b[1A\x1b[2K\x1b[G"),
      `expected erase of the painted block, got ${JSON.stringify(painted)}`);
  });

  it("repaints nothing when the frame is unchanged", () => {
    const output = sizedSink(10);
    const renderer = new IncrementalTerminalRenderer(output.target as never, { mode: "inline" });
    renderer.write("a\nb\nc");
    output.writes.length = 0;

    renderer.write("a\nb\nc");

    assert.deepEqual(output.writes, []);
  });

  it("clears a taller previous frame when the frame shrinks", () => {
    const output = sizedSink(10);
    const renderer = new IncrementalTerminalRenderer(output.target as never, { mode: "inline" });
    renderer.write("a\nb\nc");
    output.writes.length = 0;

    renderer.write("a\n");

    const painted = output.writes.join("");
    assertNoAbsoluteRows(output.writes);
    // The whole 3-line block is erased, then only "a" is written back.
    assert.ok(painted.includes("\x1b[2K\x1b[1A\x1b[2K\x1b[1A\x1b[2K\x1b[1A\x1b[2K\x1b[G"));
    assert.ok(painted.includes("\x1b[2Ka"));
    assert.ok(!visibleText(output.writes).includes("b"), "the stale second row is not rewritten");
  });

  it("clips a frame taller than the screen to one screen minus the cursor row", () => {
    const output = sizedSink(4);
    const renderer = new IncrementalTerminalRenderer(output.target as never, { mode: "inline" });

    renderer.write("1\n2\n3\n4\n5\n6");

    const painted = output.writes.join("");
    assertNoAbsoluteRows(output.writes);
    assert.ok(!painted.includes("1"), "rows above the budget are not painted");
    assert.ok(painted.includes("4") && painted.includes("6"));
  });

  it("emits a static burst above the frame without absolute addressing", () => {
    const output = sizedSink(10);
    const renderer = new IncrementalTerminalRenderer(output.target as never, { mode: "inline" });
    renderer.write("a\nb\nc");
    output.writes.length = 0;

    renderer.emitStaticBurst("hello\n");

    const painted = output.writes.join("");
    assertNoAbsoluteRows(output.writes);
    assert.ok(painted.includes("hello\n"), "burst is written verbatim");
    assert.ok(!painted.includes("a\nb\nc"), "the old frame is not frozen into the burst");
  });

  it("prints a burst emitted before the first frame, then lets the frame follow", () => {
    const output = sizedSink(10);
    const renderer = new IncrementalTerminalRenderer(output.target as never, { mode: "inline" });

    renderer.emitStaticBurst("blob\n");
    const burstWrites = output.writes.join("");
    assertNoAbsoluteRows(output.writes);
    assert.ok(burstWrites.includes("blob\n"));

    output.writes.length = 0;
    renderer.write("a\nb\n");
    assertNoAbsoluteRows(output.writes);
    assert.ok(visibleText(output.writes).includes("a\nb\n"));
  });

  it("truncates an over-wide burst row instead of wrapping the terminal", () => {
    const output = sizedSink(10, 40);
    const renderer = new IncrementalTerminalRenderer(output.target as never, { mode: "inline" });
    renderer.write("a\nb\nc");
    output.writes.length = 0;

    renderer.emitStaticBurst(`${"x".repeat(120)}\n`);

    assertNoAbsoluteRows(output.writes);
    assert.ok(output.writes.some((value) => value.includes("\x1b[?7l")), "burst write disables autowrap");
    assert.ok(output.writes.some((value) => value.includes("…")), "over-wide burst row is truncated");
  });

  it("keeps the burst tail when the next frame repaints below it", () => {
    const output = sizedSink(10, 40);
    const renderer = new IncrementalTerminalRenderer(output.target as never, { mode: "inline" });
    renderer.write("a\nb\nc");
    output.writes.length = 0;

    renderer.emitStaticBurst("s1\ns2\n");
    output.writes.length = 0;

    renderer.write("a\nb\nc");

    const painted = output.writes.join("");
    assertNoAbsoluteRows(output.writes);
    // The burst is already in the buffer; the frame must not walk up over it.
    assert.ok(!visibleText(output.writes).includes("s2"), "burst tail is not erased by the next frame");
    assert.ok(visibleText(output.writes).includes("a\nb\nc"), "frame repaints below the burst");
  });

  it("normalizes a burst that lacks a trailing newline", () => {
    const output = sizedSink(10, 40);
    const renderer = new IncrementalTerminalRenderer(output.target as never, { mode: "inline" });
    renderer.write("a\nb\nc");
    output.writes.length = 0;

    renderer.emitStaticBurst("hello");

    const painted = output.writes.join("");
    assertNoAbsoluteRows(output.writes);
    assert.ok(painted.includes("hello\n"), "burst normalized with a trailing newline");
  });

  it("re-anchors after a resize without absolute addressing", () => {
    const output = sizedSink(10);
    const renderer = new IncrementalTerminalRenderer(output.target as never, { mode: "inline" });
    renderer.write("a\nb\nc\nd");
    output.writes.length = 0;

    renderer.emitStaticBurst("s1\ns2\n");
    output.writes.length = 0;

    output.target.rows = 8;
    renderer.write("a\nb\nc\nd");

    assertNoAbsoluteRows(output.writes);
    assert.ok(visibleText(output.writes).includes("a\nb\nc\nd"), "frame repaints after the resize");
  });

  it("clearScreen wipes the screen and repaints the frame relatively", () => {
    const output = sizedSink(10);
    const renderer = new IncrementalTerminalRenderer(output.target as never, { mode: "inline" });
    renderer.write("a\nb\nc");
    renderer.write("a\nb\nx");
    output.writes.length = 0;

    renderer.clearScreen();

    const cleared = output.writes.join("");
    assert.ok(cleared.includes("\x1b[2J\x1b[H"), "clear screen then home");
    assert.ok(visibleText(output.writes).includes("a\nb\nx"), "frame is repainted");
    assertNoAbsoluteRows(output.writes);

    output.writes.length = 0;
    renderer.write("a\nb\nx\n");
    assert.deepEqual(output.writes, [], "post-clear frames diff against the repainted baseline");
  });
});

describe("incremental renderer alternate mode", () => {
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

  it("keeps absolute top-anchored rows (no scrollback in the alternate screen)", () => {
    const output = sizedSink(10);
    const renderer = new IncrementalTerminalRenderer(output.target as never, { mode: "alternate" });

    renderer.write("one\ntwo\n");

    const painted = output.writes.join("");
    assert.match(painted, /\x1b\[1;1H\x1b\[2Kone/, "alternate mode top-anchors rows");
    assert.match(painted, /\x1b\[2;1H\x1b\[2Ktwo/);
  });
});

describe("incremental renderer pinned chrome (the input box must not flicker)", () => {
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

  it("never blanks the frame on a safe streaming burst; chrome is re-asserted in one write", () => {
    const output = sizedSink(10);
    const renderer = new IncrementalTerminalRenderer(output.target as never, { mode: "document" });
    renderer.setPinnedRows(2);
    renderer.write("L1\nL2\nC1\nC2"); // 2 content rows + 2 pinned chrome rows
    output.writes.length = 0;

    renderer.emitStaticBurst("S1\n"); // one committed line: fits the content rows

    const burstWrite = output.writes.join("");
    assert.ok(burstWrite.includes("S1\n"), "the burst row is written");
    assert.doesNotMatch(burstWrite, /\x1b\[2K/, "a safe burst erases no frame row (no blank gap)");
    assert.doesNotMatch(burstWrite, /\x1b\[2J/, "no full-screen clear");

    output.writes.length = 0;
    renderer.write("L3\nC1\nC2"); // the committed row drops out of the frame
    const frameWrite = output.writes.join("");
    assert.ok(frameWrite.includes("L3"), "the new live row is painted");
    // After a safe burst the frame sits one row lower on screen; chrome that
    // did NOT move on screen emits zero bytes (diffed by physical position,
    // not by frame index). No bytes for stable chrome = no flicker at all.
    assert.ok(!frameWrite.includes("C1") && !frameWrite.includes("C2"),
      "chrome that stayed on its physical row is diffed to zero bytes");
  });

  it("emits zero bytes for a settled frame: stable chrome is diffed, not re-emitted", () => {
    const output = sizedSink(10);
    const renderer = new IncrementalTerminalRenderer(output.target as never, { mode: "document" });
    renderer.setPinnedRows(2);
    renderer.write("L1\nL2\nC1\nC2");
    renderer.emitStaticBurst("S1\n");
    renderer.write("L3\nC1\nC2");
    output.writes.length = 0;

    renderer.write("L3\nC1\nC2"); // e.g. a spinner tick with an unchanged frame

    assert.deepEqual(output.writes, [],
      "an unchanged frame — including the input box — emits nothing");
  });

  it("coalesces several safe bursts that land before the next frame", () => {
    const output = sizedSink(10);
    const renderer = new IncrementalTerminalRenderer(output.target as never, { mode: "document" });
    renderer.setPinnedRows(2);
    renderer.write("L1\nL2\nL3\nC1\nC2");
    output.writes.length = 0;

    renderer.emitStaticBurst("A\n");
    renderer.emitStaticBurst("B\n");
    const burstWrites = output.writes.join("");
    assert.ok(burstWrites.includes("A\n") && burstWrites.includes("B\n"), "both bursts are written");
    assert.doesNotMatch(burstWrites, /\x1b\[2K/, "neither burst blanks the frame");

    output.writes.length = 0;
    renderer.write("L4\nC1\nC2");
    const frameWrite = output.writes.join("");
    assert.ok(frameWrite.includes("L4"), "the advanced live row is painted");
  });

  it("falls back to the legacy blank + forced repaint for oversized seal bursts", () => {
    const output = sizedSink(10);
    const renderer = new IncrementalTerminalRenderer(output.target as never, { mode: "inline" });
    renderer.setPinnedRows(2);
    renderer.write("L1\nL2\nC1\nC2");
    output.writes.length = 0;

    renderer.emitStaticBurst("a\nb\nc\n"); // 3 rows > 2 content rows → legacy path

    const burstWrite = output.writes.join("");
    assert.match(burstWrite, /\x1b\[\d+;1H\x1b\[2K/, "the legacy path blanks the frame region");

    output.writes.length = 0;
    renderer.write("L1\nL2\nC1\nC2");
    const frameWrite = output.writes.join("");
    assert.ok(frameWrite.includes("L1") && frameWrite.includes("C2"),
      "the next frame repaints the whole frame against the empty baseline");
  });

  it("keeps the no-blank behavior when no pinned rows are reported", () => {
    const output = sizedSink(10);
    const renderer = new IncrementalTerminalRenderer(output.target as never, { mode: "document" });
    renderer.write("L1\nL2\nC1\nC2");
    output.writes.length = 0;

    renderer.emitStaticBurst("S1\n"); // P=0 → the whole frame is content, still no erase

    const burstWrite = output.writes.join("");
    assert.doesNotMatch(burstWrite, /\x1b\[2K/, "no erasure even without a pinned chrome report");
  });

  it("repaints chrome that moved on screen when the frame shrinks after a safe burst (submit collapse)", () => {
    const output = sizedSink(12);
    const renderer = new IncrementalTerminalRenderer(output.target as never, { mode: "document" });
    renderer.setPinnedRows(4);
    const chrome = ["ST", "IN", "IN", "IN"];
    renderer.write(["W1","W2","W3","W4","W5","W6","W7","W8", ...chrome].join("\n"));
    output.writes.length = 0;

    // The user message seals as a safe burst...
    renderer.emitStaticBurst("U1\n");
    assert.doesNotMatch(output.writes.join(""), /\x1b\[2K/, "the burst itself erases nothing");

    // ...and the welcome panel collapses in the same commit: the frame is
    // shorter, so every chrome row sits at a NEW physical screen row. The
    // diff must repaint them instead of skipping them (the composer would
    // otherwise stay blank until a much later frame).
    output.writes.length = 0;
    renderer.write(["M1", ...chrome].join("\n"));
    const frameWrite = output.writes.join("");
    assert.ok(frameWrite.includes("ST") && frameWrite.includes("IN"),
      "chrome rows that moved onto new screen rows are repainted");
  });

  it("re-asserts the pinned chrome in the same write for oversized seal bursts", () => {
    const output = sizedSink(20);
    const renderer = new IncrementalTerminalRenderer(output.target as never, { mode: "document" });
    renderer.setPinnedRows(3);
    renderer.write(["c1","c2","c3","c4","c5","c6","c7","c8","c9","c10", "ST", "IN1", "IN2"].join("\n"));
    output.writes.length = 0;

    // 12 burst rows > 10 content rows -> oversized path. The burst plus the
    // chrome must land in ONE write: no gap where the composer is blank.
    renderer.emitStaticBurst(`${Array.from({ length: 12 }, (_, i) => `U${i + 1}`).join("\n")}\n`);
    const burstWrite = output.writes.join("");
    assert.ok(burstWrite.includes("U12"), "the burst is written");
    assert.ok(burstWrite.includes("ST") && burstWrite.includes("IN1") && burstWrite.includes("IN2"),
      "the composer chrome is re-asserted atomically with the burst");
    assert.doesNotMatch(burstWrite, /\x1b\[2J/, "no full-screen clear");
  });

  it("bottom-anchors the chrome tail when an oversized burst leaves no room below", () => {
    const output = sizedSink(20);
    const renderer = new IncrementalTerminalRenderer(output.target as never, { mode: "document" });
    renderer.setPinnedRows(10);
    renderer.write(["c1","c2","c3","c4","c5","c6","c7","c8","c9","c10", "ST", "IN1", "IN2", "IN3", "IN4", "IN5", "IN6", "IN7", "IN8", "IN9"].join("\n"));
    output.writes.length = 0;

    // 12 burst rows + 10 chrome rows cannot both fit below the anchor: the
    // TAIL of the chrome (status bar, prompt input) must stay visible.
    renderer.emitStaticBurst(`${Array.from({ length: 12 }, (_, i) => `U${i + 1}`).join("\n")}\n`);
    const burstWrite = output.writes.join("");
    assert.ok(burstWrite.includes("U12"), "the burst is written");
    assert.ok(burstWrite.includes("IN9") && burstWrite.includes("IN8"),
      "the composer tail (input rows) is re-asserted, its head may wait for the repaint");
  });
});
