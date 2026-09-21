import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveShell, describeShell } from "../src/tools/shell.ts";

function fakeIsFile(existing: string[]) {
  const set = new Set(existing.map((path) => path.toLowerCase()));
  return (path: string) => set.has(path.toLowerCase());
}

describe("resolveShell", () => {
  it("uses bash -lc on non-Windows platforms", () => {
    const shell = resolveShell({ platform: "linux" });
    assert.deepEqual(shell, { command: "bash", args: ["-lc"], kind: "bash" });
  });

  it("prefers pwsh.exe from PATH on Windows", () => {
    const pwsh = "D:\\Tools\\pwsh.exe";
    const shell = resolveShell({
      platform: "win32",
      env: { PATH: "C:\\bin;D:\\Tools", SystemRoot: "C:\\Windows" },
      isFile: fakeIsFile([pwsh]),
    });
    assert.equal(shell.kind, "powershell");
    assert.equal(shell.command, pwsh);
    assert.ok(shell.args.includes("-NoProfile"));
    assert.ok(shell.args.includes("-Command"));
  });

  it("falls back to Windows PowerShell 5.1 when pwsh is absent", () => {
    const powershell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    const shell = resolveShell({
      platform: "win32",
      env: { PATH: "C:\\bin", SystemRoot: "C:\\Windows" },
      isFile: fakeIsFile([powershell]),
    });
    assert.equal(shell.kind, "powershell");
    assert.equal(shell.command, powershell);
  });

  it("falls back to cmd.exe when no PowerShell exists", () => {
    const shell = resolveShell({
      platform: "win32",
      env: { PATH: "C:\\bin", ComSpec: "C:\\Windows\\system32\\cmd.exe" },
      isFile: fakeIsFile([]),
    });
    assert.deepEqual(shell, {
      command: "C:\\Windows\\system32\\cmd.exe",
      args: ["/D", "/S", "/C"],
      kind: "cmd",
    });
  });

  it("ignores relative PATH entries so the workspace cannot inject a shell", () => {
    const shell = resolveShell({
      platform: "win32",
      env: { PATH: ".;..\\evil;C:\\bin", SystemRoot: "C:\\Windows" },
      isFile: fakeIsFile(["evil/pwsh.exe"]),
    });
    // Only absolute PATH dirs and the fixed Program Files location may match.
    assert.notEqual(shell.command, "evil/pwsh.exe");
    assert.equal(shell.kind, "cmd");
  });

  it("matches environment variable names case-insensitively", () => {
    const shell = resolveShell({
      platform: "win32",
      env: { path: "C:\\bin", comspec: "C:\\cmd.exe" },
      isFile: fakeIsFile([]),
    });
    assert.equal(shell.command, "C:\\cmd.exe");
  });

  it("describes shell syntax expectations per shell kind", () => {
    const bash = describeShell({ command: "bash", args: ["-lc"], kind: "bash" });
    const pwsh = describeShell({ command: "pwsh", args: [], kind: "powershell" });
    const cmd = describeShell({ command: "cmd", args: [], kind: "cmd" });
    assert.match(bash, /bash/);
    assert.match(pwsh, /PowerShell/);
    assert.match(pwsh, /not bash or cmd/);
    assert.match(cmd, /cmd/);
  });
});
