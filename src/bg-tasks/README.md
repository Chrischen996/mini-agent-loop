# Background Task Suite

Self-contained persistent background task runtime for `mini-agent-loop`.
Zero Pi-SDK dependency: it borrows the start-gate / pipe-pane / atomic-result
design of `pi-background-task`, but runs entirely inside this project. The
`auto` backend uses an isolated tmux server when available and falls back to a
detached Node process when tmux is unavailable.

## Module layout

```
src/bg-tasks/
├── store.ts      — atomic JSON persistence (meta/result/cancel/gate files)
├── backend.ts    — shared backend contract
├── tmux.ts       — isolated tmux socket + pipe-pane + send-keys
├── process.ts    — detached process fallback with PID and log redirection
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
dispose }`. CLI, TUI, and the HTTP server wire it in behind the
`MINI_AGENT_BG_TASKS` env flag (default on; set `0`/`false` to disable). The
flag controls registration. CLI/TUI initialize the manager during startup;
the HTTP server registers the tools synchronously and initializes the manager
on the first background-task call. `MINI_AGENT_BG_BACKEND=auto|tmux|process`
selects the backend; `auto` is the default and falls back to `process` when
tmux is missing. Process-backed tasks support status, logs, waiting, timeout,
and cancellation; interactive `bg_send` requires tmux.

The HTTP server also exposes workspace-scoped control routes:
`GET/POST /api/background-tasks`, `GET /api/background-tasks/:taskId`,
`GET /api/background-tasks/:taskId/logs`, `POST /api/background-tasks/wait`,
`POST /api/background-tasks/:taskId/input`, and
`POST /api/background-tasks/:taskId/kill`.

## Tests

- `test/bg-tasks.test.ts` — pure unit tests: store atomicity, tool surface,
  argument validation. No tmux required.
- `test/bg-tasks.process.test.ts` — detached process fallback, restart recovery,
  logs, and cancellation.
- `test/background-tasks.routes.test.ts` — workspace-scoped HTTP controls and
  permission checks.
- `test/bg-tasks.integration.test.ts` — full `start → status → logs → kill`
  and `bg_wait` / timeout flows against a real tmux. Tests skip
  automatically when `tmux -V` fails, so CI without tmux stays green.

Run locally:

```bash
npx tsx --test test/bg-tasks.test.ts test/bg-tasks.integration.test.ts
```

## TUI surface

`/bg-tasks` slash command (registered in `src/tui/slash-commands.ts`, handled
in `src/tui/App.tsx`): opens the **live panel** (B) —
`src/tui/components/BgTaskLivePanel.tsx` — a persistent floating panel with
arrow-key task selection, an inline log tail for the selected task, `r` to
force a refresh, `Esc` to close, and a 1.5s auto-refresh while it is open.
It also keeps the original one-shot `ADD_NOTICE` snapshot before the panel
opens. The panel lazily creates a `BgTaskManager` on first use, so TUI startup
never blocks on a missing tmux. When the flag is off (`MINI_AGENT_BG_TASKS=0`)
or the manager cannot be created, the card says so instead of crashing.

While any task is running, the status bar shows `N bg tasks` (1s polling in
`App.tsx`, appended by `StatusBar` after the regular segments). `bg_*` tool
calls also render as regular Claude-Code-style rows via the `BgStart` /
`BgStatus` / `BgLogs` / `BgSend` / `BgWait` / `BgKill` labels added in
`src/tui/tool-lines.ts`.

`bg_send` accepts literal text, `enter: true`, or a `key` from the allow-list
`ctrl_c | ctrl_d | ctrl_z | up | down | left | right` (tmux-backed tasks only).

## Known gaps (next steps)

1. **Interactive process fallback** — detached process tasks intentionally do
   not expose stdin after a manager restart; use tmux when a task needs input.

## Features (implemented)

### Log search & filters (`bg_search_logs`)

`bg_search_logs` searches a task log by keyword (`search`), log level
(`level`: `debug` / `info` / `warn` / `error`), with optional context lines
(`context`) and reverse ordering (`reverse`). The result reports `matchCount`
and the matched windows.

### Task scheduling (`bg_start`)

`bg_start` accepts optional scheduling hints — `priority`
(`high` / `normal` / `low`), `maxConcurrent`, `cpuLimit`, and `memoryLimit`.
These are persisted on the task meta and exposed through the tool schema;
the backend applies them where the platform supports them.

### Task snapshots & replay (`bg_snapshot` / `bg_replay`)

`bg_snapshot` writes a JSON snapshot of a task's command, cwd, exit code,
status, and tags under `.bg-tasks/instances/<id>/snapshots/`. `bg_replay`
reads such a snapshot and starts a fresh task with the same parameters.

### Template library (`.bg-tasks/templates.json`)

`bg_start` accepts a `template` name that is looked up in
`.bg-tasks/templates.json` (resolved next to the instance root). The template
may supply `command`, `name`, `cwd`, `timeout`, and `tags`, letting you
encode common workflows and start them by name.

### Real-time push (WebSocket)

The manager extends `EventEmitter` and emits `changed` events on every task
state transition. A dedicated `/api/background-tasks/stream` WebSocket
endpoint can fan these events out to clients; the TUI today polls every 1.5s.
