import test from "node:test";
import assert from "node:assert/strict";
import { parseWebLauncherArgs, webLauncherHelp } from "../src/web-launcher.ts";

test("web launcher parses workspace, port, and browser options", () => {
  assert.deepEqual(parseWebLauncherArgs([
    "--workspace=/tmp/project",
    "--port",
    "3456",
    "--no-open",
  ]), {
    workspace: "/tmp/project",
    port: 3456,
    openBrowser: false,
    help: false,
  });
});

test("web launcher rejects invalid or unknown options", () => {
  assert.throws(() => parseWebLauncherArgs(["--port", "0"]), /Invalid port/);
  assert.throws(() => parseWebLauncherArgs(["--unknown"]), /Unknown option/);
});

test("web launcher help identifies the standalone Web entry", () => {
  assert.match(webLauncherHelp(), /mini-agent-loop-web/);
  assert.match(webLauncherHelp(), /--no-open/);
});
