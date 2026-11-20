import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import {
  CURSOR_PROBE_TIMEOUT_ENV,
  DEFAULT_CURSOR_PROBE_TIMEOUT_MS,
  queryCursorRow,
  resolveCursorProbeTimeoutFromEnv,
  type ProbeStdin,
  type ProbeStdout,
} from "../src/tui/cursor-probe.ts";
import { createTerminalStdin } from "../src/tui/terminal-stdin.ts";

type Harness = {
  stdin: ProbeStdin;
  stdout: ProbeStdout;
  rawModes: boolean[];
  writes: string[];
  emit(data: string): void;
};

function harness(layoutMode: "inline" | "alternate" | "document" = "document", timeoutMs = 30): Harness {
  const stream = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode: (mode: boolean) => {
      stream.isRaw = mode;
      rawModes.push(mode);
      return stream;
    },
    ref: () => stream,
    unref: () => stream,
  });
  const rawModes: boolean[] = [];
  const writes: string[] = [];
  const stdout = Object.assign(new PassThrough(), {
    isTTY: true,
    write: (data: string) => {
      writes.push(data);
      return true;
    },
  });
  return {
    stdin: stream as unknown as ProbeStdin,
    stdout: stdout as unknown as ProbeStdout,
    rawModes,
    writes,
    emit: (data: string) => stream.emit("data", Buffer.from(data, "utf8")),
  };
}

const options = (h: Harness, layoutMode: "inline" | "alternate" | "document" = "document", timeoutMs = 30) => ({
  stdin: h.stdin,
  stdout: h.stdout,
  layoutMode,
  timeoutMs,
});

describe("TUI startup cursor probe", () => {
  it("restores a flowing cooked stdin after a successful cursor report", async () => {
    const h = harness();
    const promise = queryCursorRow(options(h));
    await Promise.resolve();
    h.emit("\x1b[7;12R");

    const result = await promise;
    assert.equal(result.row, 7);
    assert.equal(result.leftover, "");
    assert.deepEqual(h.writes, ["\x1b[6n"]);
    assert.deepEqual(h.rawModes, [true, false]);
    assert.equal(h.stdin.isRaw, false, "raw mode is restored");
    assert.equal(h.stdin.isPaused(), false, "flowing stdin is resumed for Ink");
  });

  it("restores a paused raw stdin after a timeout", async () => {
    const h = harness();
    h.stdin.pause();
    h.stdin.setRawMode?.(true);
    const promise = queryCursorRow(options(h));
    await Promise.resolve();
    h.emit("typed during boot");

    const result = await promise;
    assert.equal(result.row, undefined);
    assert.equal(result.leftover, "typed during boot");
    assert.equal(h.stdin.isRaw, true, "previous raw mode is preserved");
    assert.equal(h.stdin.isPaused(), true, "previous paused state is preserved");
  });

  it("keeps surrounding keystrokes and tolerates a split cursor report", async () => {
    const h = harness();
    const promise = queryCursorRow(options(h));
    await Promise.resolve();
    h.emit("he\x1b[7;");
    h.emit("12Rllo");

    const result = await promise;
    assert.equal(result.row, 7);
    assert.equal(result.leftover, "hello", "only DSR bytes are removed");
    assert.equal(h.stdin.isPaused(), false);
  });

  it("does not discard noise before a cursor report", async () => {
    const h = harness();
    const promise = queryCursorRow(options(h));
    await Promise.resolve();
    h.emit("\x1b[A\x1b[7;12R");

    const result = await promise;
    assert.equal(result.row, 7);
    assert.equal(result.leftover, "\x1b[A");
  });

  it("keeps a bare escape keystroke that is not part of a cursor report", async () => {
    const h = harness();
    const promise = queryCursorRow(options(h));
    await Promise.resolve();
    h.emit("\x1b");
    h.emit("\x1b[7;12R");

    const result = await promise;
    assert.equal(result.row, 7);
    assert.equal(result.leftover, "\x1b");
  });

  it("replays a partial report prefix on timeout instead of dropping it", async () => {
    const h = harness();
    const promise = queryCursorRow(options(h));
    await Promise.resolve();
    h.emit("a\x1b[7;");

    const result = await promise;
    assert.equal(result.row, undefined);
    assert.equal(result.leftover, "a\x1b[7;");
  });

  it("skips the probe without touching stdin in the alternate screen", async () => {
    const h = harness("alternate");
    h.stdin.pause();
    const result = await queryCursorRow(options(h, "alternate"));

    assert.deepEqual(result, { leftover: "" });
    assert.deepEqual(h.writes, []);
    assert.deepEqual(h.rawModes, []);
    assert.equal(h.stdin.isPaused(), true);
  });

  it("forwards probe-time keystrokes through the Ink stdin adapter", async () => {
    const h = harness();
    const probe = queryCursorRow(options(h));
    await Promise.resolve();
    h.emit("hi\x1b[7;12R");
    const result = await probe;

    // The app creates the adapter after the probe, then replays the leftover.
    const adapter = createTerminalStdin(h.stdin as Parameters<typeof createTerminalStdin>[0]);
    const reads: string[] = [];
    adapter.on("data", (chunk: string) => reads.push(chunk));
    if (result.leftover) adapter.write(result.leftover);
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(reads.join(""), "hi");
    assert.equal(result.row, 7);
    assert.equal(adapter.isRaw, false);
    adapter.dispose();
  });
});

describe("Cursor probe timeout configuration", () => {
  it("defaults to the documented timeout", () => {
    assert.equal(DEFAULT_CURSOR_PROBE_TIMEOUT_MS, 300);
    assert.equal(resolveCursorProbeTimeoutFromEnv({}), 300);
  });

  it("reads MINI_AGENT_CURSOR_PROBE_MS and clamps junk", () => {
    assert.equal(resolveCursorProbeTimeoutFromEnv({ [CURSOR_PROBE_TIMEOUT_ENV]: "120" }), 120);
    assert.equal(resolveCursorProbeTimeoutFromEnv({ [CURSOR_PROBE_TIMEOUT_ENV]: "0" }), 0, "0 disables the probe");
    assert.equal(resolveCursorProbeTimeoutFromEnv({ [CURSOR_PROBE_TIMEOUT_ENV]: "-5" }), 300);
    assert.equal(resolveCursorProbeTimeoutFromEnv({ [CURSOR_PROBE_TIMEOUT_ENV]: "abc" }), 300);
    assert.equal(resolveCursorProbeTimeoutFromEnv({ [CURSOR_PROBE_TIMEOUT_ENV]: "999999" }), 5000);
  });

  it("skips the probe without touching stdin when it is disabled", async () => {
    const h = harness();
    const result = await queryCursorRow(options(h, "document", 0));

    assert.deepEqual(result, { leftover: "" });
    assert.deepEqual(h.writes, [], "no DSR query is written");
    assert.deepEqual(h.rawModes, [], "stdin is never taken over");
    assert.equal(h.stdin.isPaused(), false);
  });

  it("gives up after the configured wait", async () => {
    const h = harness();
    const startedAt = Date.now();
    const result = await queryCursorRow(options(h, "document", 20));
    assert.equal(result.row, undefined);
    assert.ok(Date.now() - startedAt >= 15, "the timeout is honored");
    assert.equal(h.stdin.isPaused(), false);
  });
});
