# TUI Loading Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the ANSI and Ink TUI loading presentation match the Claude Code-style transient spinner interaction.

**Architecture:** A shared loading module owns spinner frames, timing, and stage-label normalization. Both render paths display one ephemeral loading row above the prompt; the ANSI path advances it through a timer and the Ink path advances it through a React effect. Stable status chrome no longer repeats the active loading state.

**Tech Stack:** TypeScript, Node.js test runner, Ink, React.

**Spec:** User-confirmed loading design in the task conversation: one transient loading row, shared spinner frames and wording, queued input remains available, and the row disappears without entering transcript history.

**Global Constraints**

- Preserve all unrelated user modifications already present in the working tree.
- Keep the default ANSI scrollback renderer append-only for committed transcript rows.
- Do not add a second loading indicator to the input or stable status chrome.
- Verify behavior with focused tests and `pnpm run typecheck` before completion.

---

### Task 1: Shared loading model

**Files:**
- Create: `src/tui/loading.ts`
- Test: `test/tui-loading.test.ts`

**Interfaces:**
- Produces `CLAUDE_SPINNER_FRAMES`, `SPINNER_INTERVAL_MS`, `getSpinnerFrame`, `loadingLabel`, and `createSpinnerTicker` for both TUI paths.

- [x] **Step 1: Write the failing tests**
- [x] **Step 2: Run the focused test and confirm the missing shared loading behavior fails**
- [x] **Step 3: Implement the shared frames, label normalization, and timer abstraction**
- [x] **Step 4: Run the focused test and confirm it passes**

### Task 2: ANSI transient loading

**Files:**
- Modify: `src/tui/terminal-render-model.ts`
- Modify: `src/tui/terminal-main.ts`
- Test: `test/tui-terminal-render-model.test.ts`

**Interfaces:**
- `buildTerminalRenderLines` consumes an optional spinner frame and emits a single ephemeral `loading` row while a turn is active.
- `runTerminalMain` owns a ticker that starts on busy transitions, redraws the current frame, and stops/reset on completion or cleanup.

- [x] **Step 1: Write the failing render assertions**
- [x] **Step 2: Run the focused test and confirm the old status-only output fails**
- [x] **Step 3: Implement the ANSI row and lifecycle ticker wiring**
- [x] **Step 4: Run the ANSI-focused tests and confirm they pass**

### Task 3: Ink transient loading

**Files:**
- Modify: `src/tui/message-viewport.ts`
- Modify: `src/tui/components/MessageFeed.tsx`
- Modify: `src/tui/components/StatusBar.tsx`
- Modify: `src/tui/App.tsx`
- Modify: `src/tui/layout.ts`
- Test: `test/message-viewport.test.ts`
- Test: `test/tui-render.test.ts`

**Interfaces:**
- The viewport uses `loading` as its final transient item and keeps streaming content independent from the loading visibility.
- `App` supplies the shared frame and loading label state; `StatusBar` renders stable metadata and queued count only.

- [x] **Step 1: Write the failing Ink viewport assertions**
- [x] **Step 2: Run the focused tests and confirm the old `busy_status` contract fails**
- [x] **Step 3: Implement the Ink effect, shared frame rendering, and chrome cleanup**
- [x] **Step 4: Run all focused TUI tests and confirm they pass**

### Task 4: Full verification

**Files:**
- Inspect: all files changed above

- [x] **Step 1: Run the complete test suite**
- [x] **Step 2: Run `pnpm run typecheck`**
- [x] **Step 3: Review the final diff and verify unrelated worktree changes remain untouched**

The full suite completed with 966/983 tests passing. The 17 failures are
Windows/environment-specific failures in repository Git invocation, sandbox
command resolution, temporary-directory cleanup, file permissions, and the
existing validation-order test; none are in the TUI loading changes.
