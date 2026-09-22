#!/usr/bin/env node
// P4: the published `mini-agent-loop` bin is the pi-tui canonical
// entrypoint. The Ink client remains available for one release as the
// `--renderer=ink` fallback; the raw ANSI scrollback variant is
// `dist/terminal.js`.
//
// Routing:
//   --renderer=ink        → dist/tui-ink.js (Ink, transition period)
//   --renderer=scrollback → dist/terminal.js (raw ANSI)
//   default               → pi-tui (dist/terminal-main.js)
//
// The env-var equivalent (MINI_AGENT_TUI_RENDERER=ink|scrollback) is
// read by the shared display-mode resolver so a user who sets the env
// var gets the same routing without the flag.
//
// The sibling bundles are emitted by build.ts into dist/ next to this
// file. The dynamic imports below are marked external in build.ts and
// `@vite-ignore`d so the bundler leaves them as runtime `import()`
// calls that resolve against the sibling files in dist/.
import process from "node:process";

const args = process.argv.slice(2);

function argValue(flag: string): string | undefined {
  const inline = args.find((arg) => arg.startsWith(`${flag}=`));
  if (inline) return inline.slice(flag.length + 1);
  const index = args.indexOf(flag);
  if (index >= 0) return args[index + 1];
  return undefined;
}

const renderer = (argValue("--renderer") ?? process.env.MINI_AGENT_TUI_RENDERER ?? "").trim().toLowerCase();

if (renderer === "ink" || renderer === "react") {
  // Transition-period fallback: the Ink client stays wired until the
  // follow-up release deletes it.
  // @ts-ignore — sibling dist bundle emitted by build.ts; no .d.ts.
  await import(/* @vite-ignore */ "./tui-ink.js");
} else if (renderer === "scrollback" || renderer === "ansi" || renderer === "legacy-ansi") {
  process.env.MINI_AGENT_TUI_MODE = "scrollback";
  // Raw ANSI scrollback renderer, no pi-tui dependency.
  // @ts-ignore — sibling dist bundle emitted by build.ts; no .d.ts.
  await import(/* @vite-ignore */ "./terminal.js");
} else {
  // Default: the pi-tui canonical entrypoint. `terminal-main.js` is
  // bundled from src/tui/terminal-main.ts and is a no-op when run
  // without a TTY (it throws "TUI requires an interactive terminal").
  process.env.MINI_AGENT_TUI_MODE = "pi";
  // @ts-ignore — sibling dist bundle emitted by build.ts; no .d.ts.
  await import(/* @vite-ignore */ "./terminal-main.js");
}
