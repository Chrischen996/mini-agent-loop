# Background Task Suite

Self-contained tmux-backed background task runtime for `mini-agent-loop`.
Zero Pi-SDK dependency: it borrows the start-gate / pipe-pane / atomic-result
design of `pi-background-task`, but runs entirely inside this project.

## Module layout

```
src/bg-tasks/
├── store.ts      — atomic JSON persistence (meta/result/cancel/gate files)
├── tmux.ts       — isolated tmux socket + pipe-pane + send-keys
├── runner.ts     — pane-side executor: waits for start gate, runs $SHELL -lc, writes result.json
├── manager.ts    — BgTaskManager: state machine, waits, timeouts, reconciliation
├── tools.ts      — six tool definitions (bg_start/bg_status/bg_logs/bg_send/bg_wait/bg_kill)
└── utils.ts      — shellQuote helper
```

Data lives under `<project>/.bg-tasks/instances/<instanceId>/<taskId>/` with
`0o700` dirs and `0o600` files. `result.json` is authoritative and never
overwritten once present.

## Integration

`createBgTaskSuite(cwd)` in `src/tools/index.ts` returns `{ tools, manager,
dispose }`. `cli.ts` and `tui/ink-main.tsx` wire it in behind the
`MINI_AGENT_BG_TASKS` env flag (default on; set `0`/`false` to disable). The
flag only controls registration — when tmux is missing the tools are
gracefully omitted and a warning is printed.

## Tests

- `test/bg-tasks.test.ts` — pure unit tests: store atomicity, tool surface,
  argument validation. No tmux required.
- `test/bg-tasks.integration.test.ts` — full `start → status → logs → kill`
  and `bg_wait` / timeout flows against a real tmux. Tests skip
  automatically when `tmux -V` fails, so CI without tmux stays green.

Run locally:

```bash
npx tsx --test test/bg-tasks.test.ts test/bg-tasks.integration.test.ts
```

## TUI surface

`/bg-tasks` slash command (registered in `src/tui/slash-commands.ts`, handled
in `src/tui/App.tsx`): lists every task known to this TUI's manager as a
compact `ADD_NOTICE` card — status, short task id, name, runtime, exit code.
The command lazily creates a `BgTaskManager` on first use, so TUI startup
never blocks on a missing tmux. When the flag is off (`MINI_AGENT_BG_TASKS=0`)
or the manager cannot be created, the card says so instead of crashing.

While any task is running, the status bar shows `N bg tasks` (1s polling in
`App.tsx`, appended by `StatusBar` after the regular segments). `bg_*` tool
calls also render as regular Claude-Code-style rows via the `BgStart` /
`BgStatus` / `BgLogs` / `BgSend` / `BgWait` / `BgKill` labels added in
`src/tui/tool-lines.ts`.

## Known gaps (next steps)

1. **Live panel (B)** — the slash command is a one-shot snapshot. A
   persistent floating panel (arrow-key selection, inline log tail, `r` to
   refresh) is not implemented yet.
2. **`bg_send` key allow-list** — currently text + Enter only; extend with
   the `Ctrl+C/D/Z` + arrow enum once the manager exposes `sendKey`.
3. **Timeout restoration across restarts** — `restoreTimeout` re-schedules
   only when a result is missing; verify against the quit/reload semantics
   before relying on it for crash recovery.
