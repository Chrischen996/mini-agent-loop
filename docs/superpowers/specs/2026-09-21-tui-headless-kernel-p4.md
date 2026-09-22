# tui-headless-kernel P4: entrypoint switch + transition period

Phase P4 of the 2026-09-21 headless-kernel design review. Lands the
entrypoint switch: `dist/tui.js` is now a renderer router that defaults
to the pi-tui canonical entrypoint, with a one-release `--renderer=ink`
fallback and a `--renderer=scrollback` raw-ANSI variant.

The legacy chain (`main.ts` + `legacy-render.ts` + `tui:legacy`) is
**not deleted yet** — it stays as a third rollback channel for this
release and is removed in the P4-follow-up release after the pi-tui
path has fielded a patch cycle.

## What landed

### 1. `src/tui/tui-bin.ts` — the renderer router

The new `dist/tui.js` entry. Three routing paths, selected by
`--renderer=` flag or `MINI_AGENT_TUI_RENDERER` env var:

| value | bundle | notes |
|---|---|---|
| *(default)* | `terminal-main.js` | pi-tui canonical; sets `MINI_AGENT_TUI_MODE=pi` |
| `ink` / `react` | `tui-ink.js` | transition-period Ink fallback |
| `scrollback` / `ansi` | `terminal.js` | raw ANSI scrollback, no pi-tui dep |

The three sibling bundles are emitted by `build.ts` into `dist/`; the
router's dynamic `import()` calls are marked external and `@vite-ignore`d
so they resolve at runtime against the sibling files rather than being
inlined.

### 2. `build.ts` — four TUI bundles

| output | source | purpose |
|---|---|---|
| `dist/cli.js` | `src/cli.ts` | one-shot CLI (unchanged) |
| `dist/terminal-main.js` | `src/tui/terminal-main.ts` | pi-tui canonical |
| `dist/tui-ink.js` | `src/tui/ink-main.tsx` | Ink transition fallback |
| `dist/terminal.js` | `src/tui/terminal-main.ts` | raw ANSI scrollback |
| `dist/tui.js` | `src/tui/tui-bin.ts` | router (default entry) |

`@earendil-works/pi-tui` is now external so the pi-tui path loads the
third-party dep at runtime only when the default renderer is selected.

### 3. `package.json` — bin entries

```json
"mini-agent-loop": "dist/tui.js",            // now the router
"mini-agent-loop-tui": "dist/tui.js",        // alias, now the router
"mini-agent-loop-run": "dist/cli.js",        // unchanged
"mini-agent-loop-terminal": "dist/terminal.js" // NEW: raw ANSI
```

### 4. Smoke-verified routing

All three paths hit their non-TTY guard and exit cleanly:

```
$ node dist/tui.js </dev/null
TUI requires an interactive terminal            # default → pi-tui
$ node dist/tui.js --renderer=ink </dev/null
Hermes TUI requires an interactive terminal     # Ink fallback
$ node dist/tui.js --renderer=scrollback </dev/null
TUI requires an interactive terminal            # raw ANSI
```

## Verification

- `npx tsc --noEmit` clean.
- `npm run build` clean — 5 bundles emitted, router is 483 bytes.
- `test/*.test.ts`: 1358 / 1356 pass; the 2 failures are the
  documented pre-existing `message-viewport.test.ts` regression from
  commit `4753a92` (out of P4 scope).
- 47 P4-relevant tests pass (frame-scheduler 4 + store-slices 8 +
  turn-runner 6 + terminal-agent-service 10 + terminal-main-input 18 +
  tui-state remainder).

## Not in P4 (deferred to P4-follow-up release)

- **Deletion of the legacy chain**: `src/tui/main.ts`,
  `src/tui/legacy-render.ts`, the `tui:legacy` npm script, and the
  `legacy-ansi` router alias. Stays as a third rollback channel for
  this release.
- **Ink deletion**: `src/tui/ink-main.tsx` + `src/tui/App.tsx` + the
  `ink` dependency + the `tui:ink` / `tui` npm scripts. Stays as the
  `--renderer=ink` fallback for this release.
- **Per-slice standalone reducers**: the P2 seed pins the shape; the
  8-slice migration is 8 follow-up PRs, one per slice.
- **`buildRenderModel` unification**: the P3 seed lifted the
  `FrameScheduler`; the `RenderLine` IR + theme-in-backend +
  golden-snapshot test is P4-follow-up work once the entrypoints
  have fielded the router.
- **Execution entries for the 18 slash commands** in the P2
  `CommandRegistry`: the pi-tui entry keeps its inline direct-tool +
  `/multi-agent` branches until P4-follow-up converges `App.tsx` onto
  the kernel and the command execution moves into `run` bodies.
