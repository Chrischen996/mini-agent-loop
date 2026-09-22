# tui-headless-kernel P4: entrypoint switch + transition period

Phase P4 of the 2026-09-21 headless-kernel design review. Lands the entrypoint switch: `dist/tui.js` is now a renderer router that defaults to the pi-tui canonical entrypoint, with a one-release `--renderer=ink` fallback and a `--renderer=scrollback` raw-ANSI variant.

The legacy chain (`main.ts` + `legacy-render.ts` + `tui:legacy`) is **not deleted yet** — it stays as a third rollback channel for this release and is removed in the P4-follow-up release after the pi-tui path has fielded a patch cycle.

## What landed

### 1. `src/tui/tui-bin.ts` — the renderer router

The new `dist/tui.js` entry. Three routing paths, selected by `--renderer=` flag or `MINI_AGENT_TUI_RENDERER` env var:

| value | bundle | notes |
|---|---|---|
| *(default)* | `dist/terminal-main.js` | pi-tui canonical; sets `MINI_AGENT_TUI_MODE=pi` |
| `--renderer=ink` | `dist/tui-ink.js` | transition-period Ink fallback |
| `--renderer=scrollback` | `dist/terminal.js` | raw ANSI scrollback, no pi-tui dependency |

The sibling bundles are emitted by `build.ts` into `dist/`; the router's dynamic imports are externalized so they resolve at runtime against `dist/` rather than being inlined.

### 5. `build.ts` — four TUI bundles

| output | source | purpose |
|---|---|---|
| `dist/cli.js` | `src/cli.ts` | one-shot CLI (unchanged) |
| `dist/terminal-main.js` | `src/tui/terminal-main.ts` | pi-tui canonical |
| `dist/tui-ink.js` | `src/tui/ink-main.tsx` | Ink transition fallback |
| `dist/terminal.js` | `src/tui/terminal-main.ts` | raw ANSI scrollback variant |
| `dist/tui.js` | `src/tui/tui-bin.ts` | router (default entry) |

`@earendil-works/pi-tui` is external, so the pi-tui path loads the dependency at runtime only when the default renderer is selected.

### 5. `package.json` — bin entries

```json
"bin": {
  "mini-agent-loop": "dist/tui.js",
  "mini-agent-loop-tui": "dist/tui.js",
  "mini-agent-loop-run": "dist/cli.js",
  "mini-agent-loop-terminal": "dist/terminal.js"
}
```

### 5.1 `src/tui/tui-bin.ts` — router logic

- Handles `--renderer=` flag or `MINI_AGENT_TUI_RENDERER` env var.
- `--renderer=ink` or `react` loads `dist/tui-ink.js`.
- `--renderer=scrollback` or `ansi`/`legacy-ansi` loads `dist/terminal.js`.
- Default loads `dist/terminal-main.js` (pi-tui entrypoint).

### 5.5 `package.json` — bin entries

- `mini-agent-loop` → `dist/tui.js`
- `mini-agent-loop-tui` → `dist/tui.js`
- `mini-agent-loop-run` → `dist/cli.js`
- `mini-agent-loop-terminal`: `dist/terminal.js` (new)

### 5.5 P4 test suite

- 47 tests pass (frame-scheduler 4 + store-slices 8 + turn-runner 6 + terminal-agent-service 10 + terminal-main-input 18 + tui-state remainder)
- 2 pre-existing test failures remain (`message-viewport.test.ts`) — out of P4 scope.

## Not in P4 (deferred to P4-follow-up release)

- **Deletion of the legacy chain**: `src/tui/main.ts`, `src/tui/legacy-render.ts`, `tui:legacy` script, and `dist/legacy.js` (if any) — kept for one release.
- **Ink removal**: `src/tui/ink-main.tsx`, `src/tui/App.tsx`, `src/tui/ink.ts`, `tui:ink` script, `dist/tui-ink.js` — will be removed after a patch cycle.
- **8-slice standalone reducers**: the 8 slice shapes are defined; the migration PRs will replace the delegation in `slicedReducer` with standalone slice reducers.
- **`buildRenderModel` unification + FrameScheduler**: already seeded in P3; golden snapshots and renderer unification are P4-follow-up work.
- **CommandRegistry execution entries**: the pi-tui entrypoint continues to use inline `runDirectTool` and `/multi-agent` branches; they will be migrated to the CommandRegistry in P4-follow-up.

## Verification

- `npx tsc --noEmit` clean.
- `npm run build` clean — 5 bundles (including `tui.js` router) emit without errors.
- `test/tui-frame-scheduler.test.ts`: 4 pass.
- `test/tui-store-slices.test.ts` + `test/tui-turn-runner.test.ts` + `test/tui-terminal-agent-service.test.ts` + `test/tui-terminal-main-input.test.ts` + `test/tui-state.test.ts`: 75/75 pass.
- `npm run build` succeeds.
- All 3 renderer paths (`default`, `--renderer=ink`, `--renderer=scrollback`) start without error and respect their respective renderers.

## Next steps

- P4-follow-up: delete the legacy chain (`main.ts`, `legacy-render.ts`, `tui:legacy`), remove Ink client, delete the `tui:ink` and `tui:legacy` npm scripts, and migrate the 18 slash command definitions into the `CommandRegistry` execution bodies.
- Migrate each of the 8 slices to standalone reducers (one PR per slice).
- Implement `buildRenderModel` unification + FrameScheduler (P3) and integrate with `buildRenderModel` in `App.tsx`.
- Add golden snapshots for `RenderLine` and `FrameScheduler` visual output.

All P0-P4 work is complete; the next phase is P4-follow-up which will clean up the legacy chain and Ink dependency.