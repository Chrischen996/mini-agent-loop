import assert from "node:assert/strict";
import process from "node:process";
import { describe, it } from "node:test";
import { runChildProcess } from "../src/tui/child-process.ts";

describe("runChildProcess", () => {
  it("resolves successful commands", async () => {
    await runChildProcess(process.execPath, ["-e", "process.exit(0)"], {
      stdio: ["ignore", "ignore", "pipe"],
    });
  });

  it("reports non-zero exits and timeouts", async () => {
    await assert.rejects(
      runChildProcess(process.execPath, ["-e", "process.exit(3)"], {
        stdio: ["ignore", "ignore", "pipe"],
      }),
      /exited with code 3/,
    );
    await assert.rejects(
      runChildProcess(process.execPath, ["-e", "setTimeout(() => {}, 1000)"], {
        stdio: ["ignore", "ignore", "pipe"],
        timeoutMs: 50,
        timeoutMessage: "test timeout",
      }),
      /test timeout/,
    );
  });
});
