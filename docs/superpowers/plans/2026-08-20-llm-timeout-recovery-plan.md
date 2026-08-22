# LLM Timeout Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make LLM timeouts distinguishable and recoverable while preserving partial progress and preventing unsafe replay of side effects.

**Architecture:** Extend the request-signal helper with first-response, idle, and total deadline tracking. Keep the main loop conservative: retry one no-output timeout, preserve and stop on partial answer output, and pass recovered partial output through nested-agent errors. Update UI text to expose the timeout phase and avoid empty previews.

**Tech Stack:** TypeScript, Node `AbortController`, async generators, Node test runner, React/Ink TUI.

---

### Task 1: Add typed timeout phases and layered request deadlines

**Files:**
- Modify: `src/llm/retry.ts` (`LlmTimeoutError`)
- Modify: `src/llm/config.ts` (request timer helper and env parsing)
- Modify: `src/llm/chat.ts` (fetch and SSE activity hooks)
- Test: `test/llm.test.ts` and `test/stream.test.ts`

- [ ] **Step 1: Write failing timer tests**

  Add tests for a timeout helper that reports `first_response`, `stream_idle`, and `total`; verify `markResponseStarted()` disables the first-response deadline and `markActivity()` refreshes the idle deadline.

- [ ] **Step 2: Run the focused timer tests and verify they fail**

  Run `pnpm exec tsx --test test/llm.test.ts test/stream.test.ts`.
  Expected: failures because the timeout error has no phase and the request helper has no layered deadline API.

- [ ] **Step 3: Implement the minimal layered timer API**

  Add a `LlmTimeoutPhase` union and optional `phase`, `timeoutMs`, and `elapsedMs` fields to `LlmTimeoutError`. Extend `createRequestSignal` with total, first-response, and idle deadlines while preserving the existing `(parent, timeoutMs)` call shape for callers that do not opt into layered deadlines. Add `MINI_AGENT_FIRST_RESPONSE_TIMEOUT_MS` and `MINI_AGENT_STREAM_IDLE_TIMEOUT_MS` parsing, with the existing request timeout as the first-response default and a 60-second idle default.

- [ ] **Step 4: Wire fetch and stream activity into the helper**

  Mark the response as started immediately after `fetch` resolves, call `markActivity()` for each received stream chunk, and use the typed timeout phase when converting aborted fetch/read operations into `LlmTimeoutError`.

- [ ] **Step 5: Run focused tests and refactor only after green**

  Run `pnpm exec tsx --test test/llm.test.ts test/stream.test.ts` and confirm the new deadline tests plus existing stream tests pass.

### Task 2: Retry only safe no-output main-agent timeouts

**Files:**
- Modify: `src/loop.ts` (timeout retry state and events)
- Modify: `src/ui/state.ts` (retry status rendering)
- Test: `test/loop.test.ts` and `test/ui-state.test.ts`

- [ ] **Step 1: Write failing loop tests**

  Add one test where the first request times out before any answer delta and the second request succeeds; assert two calls and one `retry_attempt` event. Add one test where the stream emits text and then times out; assert one call, a preserved assistant partial message, and no retry.

- [ ] **Step 2: Run the focused loop tests and verify they fail**

  Run `pnpm exec tsx --test test/loop.test.ts test/ui-state.test.ts`.
  Expected: the no-output case throws on the first timeout and the partial-output case preserves text but has no typed retry status.

- [ ] **Step 3: Implement the minimal loop policy**

  Track one timeout recovery attempt per agent turn. In the LLM generation catch block, retry only when no answer text was streamed and no assistant response was completed; emit the existing `retry_attempt` event with `errorType: "timeout"`. Keep partial answer timeouts terminal and rethrow them with recovered messages. Do not replay any tool execution because tool execution occurs only after a completed assistant response.

- [ ] **Step 4: Render retry status in the TUI reducer**

  Handle `retry_attempt` by clearing transient stream buffers and showing a concise retry status, without adding a persistent error message.

- [ ] **Step 5: Run focused tests and verify green**

  Run `pnpm exec tsx --test test/loop.test.ts test/ui-state.test.ts` and confirm both retry-safety cases pass.

### Task 3: Return partial progress from timed-out sub-agents

**Files:**
- Modify: `src/subagent/tool.ts` (timeout recovery result)
- Test: `test/subagent.test.ts`

- [ ] **Step 1: Write a failing sub-agent timeout test**

  Use a streaming fixture that emits an assistant delta, then times out. Assert the sub-agent tool returns `isError: true`, includes a `[Partial]` marker and recovered text, and reports the timeout phase in its message.

- [ ] **Step 2: Run the focused sub-agent test and verify it fails**

  Run `pnpm exec tsx --test test/subagent.test.ts`.
  Expected: the current timeout path returns only `Sub-agent timed out...` with no recovered output.

- [ ] **Step 3: Implement partial timeout extraction**

  In the timeout catch path, read `LlmTimeoutError.messages` when present, extract the best available answer using the existing `extractBestAnswer`, preserve accumulated turns and token metadata, and return an error result containing the partial text plus the typed timeout phase. Keep `isError: true` so the parent model can decide what to do next.

- [ ] **Step 4: Run the sub-agent tests**

  Run `pnpm exec tsx --test test/subagent.test.ts` and confirm existing max-turn and failure semantics remain unchanged.

### Task 4: Make timeout diagnostics actionable in the UI and docs

**Files:**
- Modify: `src/tui/App.tsx` (phase-aware timeout message)
- Modify: `src/tui/turn-helpers.ts` (shared timeout formatter)
- Modify: `README.md` (timeout configuration)
- Test: `test/ui-state.test.ts` or a focused turn-helper test

- [ ] **Step 1: Write a failing formatter test**

  Assert a timeout with a phase and partial content produces a message naming the phase and preview, while a timeout without partial content does not render empty parentheses.

- [ ] **Step 2: Run the focused test and verify it fails**

  Run `pnpm exec tsx --test test/ui-state.test.ts`.
  Expected: the current literal template produces `partial response saved ()`.

- [ ] **Step 3: Implement the shared formatter and UI wiring**

  Add a small formatter that maps timeout phases to readable labels and only includes a preview when content exists. Use it in both timeout handling sites in the TUI.

- [ ] **Step 4: Document environment controls**

  Document `MINI_AGENT_REQUEST_TIMEOUT_MS`, `MINI_AGENT_FIRST_RESPONSE_TIMEOUT_MS`, and `MINI_AGENT_STREAM_IDLE_TIMEOUT_MS`, including defaults and the fact that idle time resets on stream activity.

- [ ] **Step 5: Run the focused UI tests**

  Run `pnpm exec tsx --test test/ui-state.test.ts` and confirm the formatter cases pass.

### Task 5: Full verification

**Files:**
- Verify: all files above

- [ ] **Step 1: Run typecheck**

  Run `pnpm run typecheck`.
  Expected: exit code 0.

- [ ] **Step 2: Run the complete test suite**

  Run `pnpm test`.
  Expected: all tests pass with no timeout-related regressions.

- [ ] **Step 3: Review the diff and status**

  Run `git -c safe.directory='C:/项目/mini-agent-loop' diff --check` and `git -c safe.directory='C:/项目/mini-agent-loop' status --short`.
  Confirm only the timeout implementation, tests, and the two planning documents are changed.
