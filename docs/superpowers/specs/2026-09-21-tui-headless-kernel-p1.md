# tui-headless-kernel P1: headless kernel seed

Phase P1 of the 2026-09-21 headless-kernel design review. Builds the L1
layer that every TUI client composes, and lands the first direct test of
the agent-turn execution path.

## What landed

```
src/tui/tui-core/
├── index.ts         # AgentSession re-export surface
├── bootstrap.ts     # bootstrapTui() — one runtime assembly factory
├── turn-runner.ts   # TurnRunner — single agent-turn execution path
└── commands.ts      # SlashCommand registry (P2 seed)
```

### 1. `bootstrap.ts` — `bootstrapTui()`

One factory replaces the runtime-assembly block that was copy-pasted
across `terminal-main.ts`, `ink-main.tsx` and `main.ts`:

- sandbox runner init (docker / node / auto)
- codebase + MCP runtime (with the MCP-error → close-codebase contract)
- base / all tool providers
- subagent factory + role-LLM config resolution
- global token budget / concurrency limits
- vision preprocessor, auto-subagent, skill discovery
- `close()` that tears down MCP + codebase + sandbox in one go

`buildRoleLlmConfigs` was copy-pasted into `terminal-main.ts` and
`main.ts`. It now lives in the kernel; entrypoints import it from
`tui-core/bootstrap.ts`.

### 2. `turn-runner.ts` — `TurnRunner`

`TerminalAgentService` (390 lines, in `src/tui/terminal-agent-service.ts`)
was already doing exactly this job for the pi-tui entrypoint, and its
docblock said *"UI code only dispatches actions; it never reimplements
the agent loop."* P1 promotes that pattern to the kernel:

- owns the single mutable `AgentMessage[]` history
- FIFO-queues concurrent prompts
- auto-continue on `MaxTurnsExceededError` (capped at `maxContinues`)
- `LlmTimeoutError` partial-response preservation
- `PermissionModeChangedError` / `abort` → `aborted` loop event
- persistence hooks (`onTurnStarted` / `onTurnFinished`)

`TerminalAgentService` is now a thin wrapper over `TurnRunner` with the
same public API, so all existing call sites keep working. The wrapper
will be deleted in P4.

### 3. `commands.ts` — `CommandRegistry` (P2 seed)

Re-exports the existing `slash-commands.ts` catalog + parse surface and
adds a `CommandDef`/`CommandRegistry` type for the P2 work. The freeze
rule takes effect now: no new command may add an `if (text === "/x")`
branch to `App.tsx` or `terminal-main.ts`.

### 4. `index.ts` — `AgentSession`

`createAgentSession({ store, runner options })` composes a
`TuiStore` + `TurnRunner` and exposes `submit` / `abort` /
`resolvePermission` / `waitForIdle` / `dispatch` / `getState`. This is
the public kernel surface every entrypoint moves to in P4.

## Verification

- `npx tsc --noEmit` clean.
- New `test/tui-turn-runner.test.ts`: 6 offline tests drive the kernel
  through a scripted `chat` fn and assert the exact store-action trace.
  Coverage: USER_MESSAGE + done-event routing, tool call + result,
  permission request + clear, FIFO queue drain, abort, direct-tool
  history.
- Existing `test/tui-terminal-agent-service.test.ts` (10 tests) still
  passes against the wrapper.

## Not in P1 (deferred)

- `store/slices.ts` — slice-split of `TuiState` + `combineReducers`
  (P1 was scoped to land the kernel seam first; slicing is its own PR to
  keep the diff reviewable).
- `App.tsx` / `main.ts` switched to `TurnRunner` — transition-period
  work, lands with P4.
- `FrameScheduler` — P3 (presentation layer).

## Pre-existing test failure (out of P1 scope, documented)

`test/message-viewport.test.ts` → "estimates more rows than the renderer
draws for wide table rows" fails on `HEAD` both with and without the P1
changes (verified via `git stash`):

```
AssertionError: expected actual (5) < estimated (5)
```

Root cause: commit `4753a92` ("fix(tui): unbind /resume…") changed
`estimateMessageHeight`'s assistant path from `countTerminalRows` to
`countMarkdownRenderRows`, and simultaneously made
`computeHistoryBlock`'s `actual` use the same function — so for a wide
markdown table the estimate and actual now agree, and the test's
invariant (`actual < estimated` for over-wrapped content) no longer
holds. The commit message claims "1328 tests pass" but this viewport
height-estimation regression slipped through.

Fix is a one-liner in `message-viewport.ts` (re-widen the estimate for
wrapped markdown, or relax the test's invariant) and is intentionally
left out of the P1 commit to keep the headless-kernel work self-contained.
Tracked as a follow-up.
