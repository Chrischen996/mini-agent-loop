# Web execution policy and recovery

Web sessions use `AgentRunPolicy` by default. Token usage, elapsed execution
time, tool calls, write calls, context compactions and stall detection determine
when a run pauses. `emergencyIterationCap` is the last safety fallback for an
unexpected loop, rather than the normal task budget.

## Configuration

`createAgentServer({ runPolicy })` overrides individual environment settings;
environment settings override the following defaults. All configured values
must be positive safe integers. Invalid values fail server initialization.

| Policy field | Environment variable | Default |
|---|---|---|
| `tokenBudget` | `MINI_AGENT_WEB_TOKEN_BUDGET` | Unlimited |
| `toolCallBudget` | `MINI_AGENT_WEB_TOOL_CALL_BUDGET` | Unlimited |
| `writeCallBudget` | `MINI_AGENT_WEB_WRITE_CALL_BUDGET` | Unlimited |
| `deadlineMs` | `MINI_AGENT_WEB_DEADLINE_MS` | Unlimited |
| `maxCompactions` | `MINI_AGENT_WEB_MAX_COMPACTIONS` | 8 |
| `stallPolicy.sameActionLimit` | `MINI_AGENT_WEB_SAME_ACTION_LIMIT` | 3 repetitions after the first occurrence |
| `stallPolicy.noProgressLimit` | `MINI_AGENT_WEB_NO_PROGRESS_LIMIT` | 6 consecutive turns with only error results |
| `emergencyIterationCap` | `MINI_AGENT_WEB_EMERGENCY_ITERATION_CAP` | 2000 |

For example:

```ts
createAgentServer({
  llm,
  runPolicy: { tokenBudget: 50000, toolCallBudget: 100, deadlineMs: 300000 },
});
```

Limits are checked at model-turn boundaries and after automatic preflight
delegation. An in-flight model request or tool batch finishes before a budget
pause, so reported usage can exceed a limit. Provider request timeouts and tool
timeouts still apply independently. Token usage is the provider-reported
`totalTokens`; responses without usage cannot contribute to this counter.
Tool calls count attempts announced by `tool_start`, including automatic
preflight and validation. Writes count the built-in `write`, `edit`, `delete`,
`mkdir`, `copy`, `move`, `patch`, and `document_edit` tool names. Calls through
shell commands, external tools and nested agents are not recursively classified
as writes. The optional shared parent/subagent `globalTokenBudget` remains a
separate control.

## Continue API

`POST /api/sessions/:id/continue` streams NDJSON from the saved checkpoint
without adding a user message. Omitting the body, or sending `{}`, allocates a
new budget using the configured defaults. The Web Continue button does this.
New limits override the configured limits for this invocation:

```json
{ "budgetMode": "new", "tokenBudget": 50000, "deadlineMs": 300000 }
```

Optional `toolCallBudget` and `writeCallBudget` are also supported. To reuse
the saved allocation and its consumed usage, send:

```json
{ "budgetMode": "remaining" }
```

Remaining mode uses the persisted policy even if server defaults have changed.
It excludes downtime from `elapsedMs` and immediately pauses if that allocation
was already exhausted. It requires a saved policy and usage; mixing new limits
with remaining mode returns HTTP 400. Unknown fields, nonnumeric values,
fractions, zero and negative limits also return HTTP 400 before execution.
Stall detection, the compaction allowance and the emergency cap restart for
each invocation; remaining mode preserves the four consumption budgets.

## Persisted state

`GET /api/sessions/:id` returns `runState` with:

- `status`, `reason`, `details`, `stepsUsed`, and `maxSteps` (the safety cap in
  policy mode).
- `budgetPolicy` and `budgetMode` for the selected allocation.
- `budgetUsage`: `tokensUsed`, `toolCallsUsed`, `writeCallsUsed`, `elapsedMs`
  charged to that allocation.
- `cumulativeBudgetUsage`: the same counters across all allocations in this
  session, including the current allocation.
- `lastFingerprint`: a digest of the latest action and result used for stall
  detection; raw tool arguments are not persisted in this field.
- `checkpointRevision`, `runId`, and `savedAt`.

Usage is saved with complete tool-result history and terminal checkpoints.
An abrupt process exit can lose work since the latest checkpoint. A restored
`running` state becomes `interrupted/server_restart`, preserving its budgets.
Older sessions may lack budget fields; new usage is accumulated from the first
available counters.

## Stop events

A policy pause first saves one `paused` checkpoint with the real reason, then
emits exactly one `run_stopped` event. It does not produce a `failed/model_error`
checkpoint or a generic `error` event for that pause. If saving fails, no stop
event claiming saved progress is emitted.

```json
{
  "type": "run_stopped",
  "stopReason": "budget_exhausted",
  "details": "Run budget exhausted (...); progress was saved.",
  "message": "Run budget exhausted (...); progress was saved.",
  "messageCount": 8,
  "budgetUsage": { "tokensUsed": 50000, "toolCallsUsed": 3, "writeCallsUsed": 1, "elapsedMs": 42000 },
  "cumulativeBudgetUsage": { "tokensUsed": 70000, "toolCallsUsed": 8, "writeCallsUsed": 2, "elapsedMs": 90000 },
  "budgetPolicy": { "tokenBudget": 50000, "emergencyIterationCap": 2000 }
}
```

`stopReason` distinguishes `budget_exhausted`, `safety_cap_reached`,
`context_exhausted`, and `stalled`. Both live and restored Web pauses display
the reason, allocation consumption and session totals.

## Compatibility

Explicit server `maxTurns`, with no `runPolicy`, enables the legacy hard stop
per block and `maxAutoContinues` bounded continuation. Its terminal event is
`max_turns`, and its persisted reason is `step_limit`. Supplying a new budget
on Continue opts that invocation into policy execution. CLI, TUI and subagent
limits retain their existing behavior; shared-policy migration is separate work.
