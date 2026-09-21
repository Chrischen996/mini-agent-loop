# Architecture

Mini Agent is a single agent runtime with three front ends. The CLI, the
terminal TUI, and the HTTP server all drive the same loop, tool registry,
permission manager, and session store — there is no per-surface fork of the
agent logic.

```text
        CLI (src/cli.ts)      TUI (src/tui/)      HTTP (src/server.ts)
                 \                  |                   /
                  \                 |                  /
                        runAgentTurn / runAgentLoop
                              (src/loop.ts)
                                    |
   +----------------+---------------+---------------+-----------------+
   |                |               |               |                 |
 LLM layer      Tool registry   Permissions     Sessions        Extensions
 src/llm/       src/tools/      src/permissions src/session-*   skills, mcp,
 src/pi-ai/     src/runtime/    .ts             src/orchestration subagent,
                                                                codebase, sandbox
```

## The core loop

`src/loop.ts` owns the execution cycle:

```text
user prompt
  -> LLM (may return tool_calls)
  -> for each tool_call (sequential):
       validate args (src/validate.ts)
       authorize (src/permissions.ts)
       execute through ToolExecutionBroker (src/runtime/)
       append tool result message
  -> LLM again
  -> stop when the assistant returns no tool_calls
```

Around that cycle it also handles system-prompt assembly, permission-mode
changes, thinking-level policy, context compaction, skill activation, auto
validation and checkpointing, Plan-Act phases, and subagent delegation.

Loop invariants:

1. Tool arguments are validated before execution.
2. A tool failure is a *message* (`isError`), not a loop crash.
3. Every tool call receives a tool result before the next LLM call.
4. The loop stops when the assistant emits zero tool calls.
5. `maxTurns` hard-stops runaway loops with a typed `MaxTurnsExceededError`
   carrying the partial history.

## Directory map

| Path | Responsibility |
|---|---|
| `src/loop.ts` | Core agent turn/loop, system prompt, phase and thinking policy |
| `src/cli.ts` | One-shot and resumable CLI entry point |
| `src/server.ts` | `createAgentServer` factory: session state, streaming turn endpoint, wiring |
| `src/server/routes/` | HTTP route modules by domain (see below) |
| `src/tui/` | Ink and pi-tui terminal client: render models, input, autocomplete, overlays |
| `src/llm/` | Chat/stream calls, retries, recovery, timeouts, vision |
| `src/pi-ai/` | Vendored provider layer — see `src/pi-ai/README.md` |
| `src/tools/` | Built-in tools: bash, read/write/edit, grep/find/ls, git, todo, validation |
| `src/runtime/` | Tool execution broker, limits, policy types, id generation |
| `src/permissions.ts` | Permission modes, risk classification, approval requests |
| `src/skills/` | Skill discovery, progressive loading, activation |
| `src/mcp/` | MCP client, config, tool adapter, approval gate |
| `src/subagent/` | Subagent tool, profiles, auto-delegation, cost accounting |
| `src/plan-act/` | In-memory plan lifecycle and phase state machine |
| `src/plan/` | On-disk plan-document kernel (create/approve/archive/history) |
| `src/orchestration/` | Background jobs, pause gate, session gate, memory store |
| `src/session-*.ts` | Session persistence, history sanitization, workspace scoping |
| `src/sandbox/` | Docker/Podman/Node sandbox runners and detection |
| `src/codebase/` | External repository fetching and DeepWiki semantic search |
| `src/git/` | Checkpoint, undo, diff, isolated-branch workflows |
| `scripts/` | Build-time generators (`generate-models.ts`) |

## HTTP route modules

`createAgentServer` keeps session state and the streaming turn endpoint, and
delegates cohesive route domains to `src/server/routes/*`. Each module takes a
narrow context object rather than closing over the whole factory, so a domain
can be read and changed in isolation.

| Module | Endpoints |
|---|---|
| `workspace.ts` | `/api/health`, `/api/workspace/list` |
| `memory.ts` | `/api/memory` |
| `jobs.ts` | `/api/jobs/*`, `/api/sessions/:id/jobs` |
| `git.ts` | `/api/git/*`, `/api/validation` |
| `models.ts` | `/api/models` |
| `subagent-profiles.ts` | `/api/subagent/profiles` |
| `permissions.ts` | `/api/sessions/:id/permission-mode`, `/permissions/:requestId` |
| `plan-act.ts` | `/api/sessions/:id/phase`, `/api/sessions/:id/plans` |
| `plan-document.ts` | `/api/sessions/:id/plan*` |
| `skills.ts` | `/api/sessions/:id/skills` |
| `files.ts` | `/api/sessions/:id/files/:fileId` |

Still owned by `src/server.ts`: `/api/config`, session CRUD (list, create, fork,
rewind, tree, delete), per-session model switching, and the streaming
`POST /api/sessions/:id/messages` turn endpoint, which is tightly coupled to
session mutation and abort handling.

## Generated artifacts

`src/pi-ai/providers/*.models.ts` and `src/pi-ai/models.generated.ts` are
generated from `src/pi-ai/providers/data/*.models.json` by
`scripts/generate-models.ts`. Edit the JSON, then run:

```bash
npm run generate-models
```

CI runs `npm run generate-models:check` and fails on drift.

## Related documents

- [`docs/security-model.md`](./security-model.md) — permission matrix, sandbox
  defaults, network egress.
- [`src/pi-ai/README.md`](../src/pi-ai/README.md) — vendored provider layer and
  its dependency boundary.
- [`docs/project-analysis.md`](./project-analysis.md) — codebase review and
  outstanding technical debt.
