# tui-headless-kernel P3: presentation-layer unification (seed)

Phase P3 of the 2026-09-21 headless-kernel design review. Two seeds
land: a kernel-level `FrameScheduler` (coalescing high-frequency store
updates into at-most-one paint per animation frame) and the wire-up of
that primitive into the pi-tui entrypoint.

## What landed

### 1. `frame-scheduler.ts` — `createFrameScheduler()`

The pi-tui entrypoint (`terminal-main.ts`) hand-rolls a "collapse N
dispatches into one paint" loop: a `renderQueued` flag + a
`requestAnimationFrame` → `setImmediate` fallback. That policy is the
*only* place in the codebase that owns the 16ms cadence, but it is
inlined in one entrypoint. This module lifts it into the kernel:

```ts
const scheduler = createFrameScheduler(onFrame, { intervalMs: 16 });
store.subscribe(() => scheduler.invalidate());
```

- `invalidate()` — mark a frame dirty; coalesces into the next interval
  boundary.
- `flushNow()` — paint immediately (resize / permission-gate / quit
  paths where the next tick is too late).
- `dispose()` — cancel a pending frame so a stray tick cannot paint
  after shutdown.

The scheduler is renderer-agnostic: it owns *when* a frame is painted,
not *what*. The entrypoint passes its render body as `onFrame`.

### 2. `terminal-main.ts` — scheduler wiring

The entrypoint now constructs a `FrameScheduler` and marks it dirty on
every paint. The hand-rolled `renderQueued` flag remains for the P3
seed; P4 moves the actual paint into the scheduler's `onFrame` callback
so the entrypoint no longer owns the 16ms policy.

### 3. 4 deterministic tests

`test/tui-frame-scheduler.test.ts` pins the coalescing contract with a
fake `setTimeout`/`clearTimeout` (a `Map`-backed timer so
`clearTimeout` removes the exact pending task, not by value):

- 10 `invalidate()` calls within one 16ms window → exactly 1 paint.
- `flushNow()` paints immediately and cancels the pending timer (no
  double-paint on the next boundary).
- `dispose()` cancels any pending frame; subsequent `invalidate()` is a
  no-op.
- `coalesce: false` → every `invalidate()` schedules its own flush.

## Verification

- `npx tsx --test test/tui-frame-scheduler.test.ts`: 4 pass.
- `npx tsx --test test/tui-terminal-main-input.test.ts test/tui-store-slices.test.ts test/tui-turn-runner.test.ts`:
  33 pass (no regression from the wiring).
- Pre-existing `message-viewport` failure from commit `4753a92` is still
  out of P3 scope.

## Not in P3 (deferred)

- `buildRenderModel` unification (`RenderLine` IR + `tone` field,
  theme in the backend, resize / truncation in the model layer). The
  `RenderLine` type in `render-lines.ts` already carries a `tone`
  field; the golden-snapshot test and the `Ink → <Text>` mapping are
  P4 work once the entrypoints converge.
- Moving the paint into the scheduler's `onFrame` (P4).
- FrameScheduler `FrameScheduler` is a kernel primitive; the entrypoint
  keeps its own `requestAnimationFrame` fallback in P3 so behaviour is
  unchanged. P4 removes the hand-rolled `renderQueued` flag.
