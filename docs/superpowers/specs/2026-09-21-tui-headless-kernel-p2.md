# tui-headless-kernel P2: store slices + command registry seed

Phase P2 of the 2026-09-21 headless-kernel design review. Two seeds land:
the 8-slice shape contract for `TuiState` and the `CommandRegistry`
execution surface. Neither changes runtime behaviour yet — both are
pinned by 对拍 tests so the later migration PRs have a safety net.

## What landed

### 1. `store-slices.ts` — 8-slice shape contract

`TuiState` (1396 lines, ~40 fields) is partitioned into 8 slices:

| slice      | fields | hot path |
|---|---|---|
| `transcript` | messages + subagent/tool overlays + revisions | LOOP_EVENT |
| `agents`     | goal / task / steps / toolCards | LOOP_EVENT |
| `todos`      | todos / todoPlan / todoItems / todoRevision | TodoWrite |
| `plan`       | phase / currentPlan | plan-act |
| `permission` | permissionMode / pendingPermission | permission gate |
| `runtime`    | streamingText / busy / model / tokens | every delta |
| `view`       | expandedThinking / focusedMessageIndex / scrollOffset | keyboard |
| `notices`    | status / thinkingMode | status changes |

`projectToSlices` / `combineSlices` round-trip is field-for-field
identical to the monolithic state (including the `undefined`-omission
convention of `createInitialState`). `transcriptSliceReducer` is the
first slice-migration seam: it projects the monolith's transcript branch
so the 对拍 test pins parity, and later PRs replace it with standalone
slice logic.

### 2. `commands.ts` — `CommandRegistry`

The P2 `CommandDef` adds an optional `run(ctx, args)` execution body to
the existing `slash-commands.ts` metadata. `createCommandRegistry`
merges the execution map onto the static catalog and exposes
`dispatch(input, ctx)` — a single entry point the pi-tui entry uses to
run a typed command line. The freeze rule is now concrete: new commands
are added as `run` entries in the execution map, not as
`if (text === "/x")` branches in `App.tsx` / `terminal-main.ts`.

The terminal-specific execution bodies (wizard state, direct-tool abort
plumbing, `/multi-agent` role setup) stay inline in `terminal-main.ts`
until P4 converges both entrypoints onto the kernel.

### 3. 对拍 tests

`test/tui-store-slices.test.ts` (8 tests):

- round-trip `combineSlices(projectToSlices(s)) === s` on the initial
  state and after a full turn (streaming + tool + done),
- monolith-vs-sliced lockstep across `USER_MESSAGE` + `LOOP_EVENT`
  (streaming / tool / subagent) + `SET_PERMISSION_MODE` /
  `TOGGLE_THINKING_MODE` / `SET_STATUS` / `MODEL_CHANGED` /
  `SCROLL_TO_BOTTOM` + `RESET` + `SUBAGENT_EVENT`,
- timestamp fields (`startedAt` / `turnStartedAt` / `lastStreamAt` /
  `durationMs`) are blanked before the comparison — two independent
  reducer runs differ by milliseconds on `Date.now()`, and the 对拍 is
  about state shape, not wall-clock.
- `todoRevision` is a module-level monotonic counter; `RESET`'s two
  independent call sites produce different values. The 对拍 blanks it
  out and asserts it is positive on both sides.

`test/tui-turn-runner.test.ts` (6 tests, P1) now type-checked against
the `LOOP_EVENT` action's `event` field via `Extract<TuiAction, …>`.

## Verification

- `npx tsc --noEmit` clean.
- `test/tui-store-slices.test.ts`: 8 pass.
- `test/tui-turn-runner.test.ts`: 6 pass.
- `test/tui-terminal-agent-service.test.ts`: 10 pass (wrapper unchanged).
- Pre-existing `message-viewport` failure from commit `4753a92` is still
  out of P2 scope.

## Not in P2 (deferred)

- Per-slice standalone reducers (replacing the `tuiReducer` delegation).
  The seed pins the shape; the migration is 8 follow-up PRs, one per
  slice, each carrying its own 对拍 test.
- `App.tsx` / `main.ts` switched to the kernel — P4.
- `FrameScheduler` — P3.
- Execution entries for the 18 slash commands — P4 (lands with the
  entrypoint convergence).
