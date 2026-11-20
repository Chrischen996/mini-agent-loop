/**
 * The boot line that fills the window before Ink paints, and its erase.
 *
 * The contract matters more than the bytes: the child may erase a line only
 * when the parent says it painted one, and only once — otherwise a RELAUNCH
 * child would eat a real line of the transcript.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  BOOT_FRAME_ENV,
  clearBootFrame,
  paintBootFrame,
  shouldPaintBootFrame,
  type BootFrameEnv,
} from "../src/tui/boot-frame.ts";

type Recorder = { isTTY?: boolean; chunks: string[]; write(chunk: string): boolean };

function recorder(isTTY = true): Recorder {
  return {
    isTTY,
    chunks: [],
    write(chunk: string) {
      this.chunks.push(chunk);
      return true;
    },
  };
}

function env(overrides: BootFrameEnv = {}): BootFrameEnv {
  return { ...overrides };
}

test("paints one line, and only when the terminal is ours", () => {
  const tty = recorder();
  assert.equal(paintBootFrame({ env: env(), stdout: tty, layoutMode: "document" }), true);
  assert.equal(tty.chunks.length, 1);
  // Clears the line, prints the text, leaves the cursor on the next row.
  assert.match(tty.chunks[0]!, /^\r\x1b\[2K.*启动中…\n$/);

  for (const layoutMode of ["alternate", "inline", "document"]) {
    const stdout = recorder();
    assert.equal(
      shouldPaintBootFrame({ env: env(), stdout, layoutMode }),
      layoutMode !== "alternate",
      `layout ${layoutMode}`,
    );
  }

  const piped = recorder(false);
  assert.equal(paintBootFrame({ env: env(), stdout: piped, layoutMode: "document" }), false);
  assert.deepEqual(piped.chunks, []);

  const underTest = recorder();
  assert.equal(
    paintBootFrame({ env: env({ NODE_TEST_CONTEXT: "child-v8" }), stdout: underTest, layoutMode: "document" }),
    false,
  );
  assert.deepEqual(underTest.chunks, []);

  const optedOut = recorder();
  assert.equal(
    paintBootFrame({ env: env({ [BOOT_FRAME_ENV]: "0" }), stdout: optedOut, layoutMode: "document" }),
    false,
  );
  assert.deepEqual(optedOut.chunks, []);
});

test("the child erases exactly one line, once", () => {
  const stdout = recorder();
  const childEnv = env({ [BOOT_FRAME_ENV]: "1" });

  assert.equal(clearBootFrame({ env: childEnv, stdout }), true);
  assert.equal(stdout.chunks.length, 1);
  // Up one row, clear it, column 0: the frame then lands on the boot line's row.
  assert.equal(stdout.chunks[0], "\x1b[1A\x1b[2K\r");
  // Marker is consumed, so a double call (or a second child) is a no-op.
  assert.equal(childEnv[BOOT_FRAME_ENV], undefined);
  assert.equal(clearBootFrame({ env: childEnv, stdout }), false);
  assert.equal(stdout.chunks.length, 1);
});

test("a child that was not told about a boot line never touches the screen", () => {
  for (const value of [undefined, "0", "true", ""]) {
    const stdout = recorder();
    const childEnv: BootFrameEnv = value === undefined ? env() : env({ [BOOT_FRAME_ENV]: value });
    assert.equal(clearBootFrame({ env: childEnv, stdout }), false, `marker ${String(value)}`);
    assert.deepEqual(stdout.chunks, []);
  }
});
