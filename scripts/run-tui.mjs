import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

const entrypoint = fileURLToPath(new URL("../src/tui/terminal-main.ts", import.meta.url));
const nodeArgs = ["--import", "tsx", entrypoint];
const useWinpty = process.platform === "win32"
  && !(process.stdin.isTTY && process.stdout.isTTY)
  && Boolean(process.env.TERM || process.env.MSYSTEM || process.env.ConEmuANSI);
const command = useWinpty ? "winpty" : process.execPath;
const args = useWinpty ? [process.execPath, ...nodeArgs] : nodeArgs;

const child = spawn(command, args, { stdio: "inherit", windowsHide: false });
child.once("error", (error) => {
  console.error(`[tui] failed to start ${command}: ${error.message}`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
