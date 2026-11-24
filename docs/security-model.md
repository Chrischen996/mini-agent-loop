# Security model: permissions, sandboxing, and egress

This document is the authoritative reference for **which tools can do what, in
which permission mode, and what reaches the network**. It exists because Mini
Agent ships a shell tool, container/process sandboxes, and MCP clients in the
same runtime; operators need a single place that states the defaults.

## 1. Permission modes

Sessions run in two permission modes (`src/permissions.ts`). All entry points
(CLI, TUI, HTTP) default to **`plan`** unless `MINI_AGENT_PERMISSION_MODE` or an
explicit option overrides it.

| Mode | Intent | Behavior |
|---|---|---|
| `plan` | Analysis only (default) | Read-only tools run freely. Writes, `validate_workspace`, dangerous shell, and **every** MCP tool are blocked as high risk. |
| `bypass` | Trusted automation | Every tool auto-allows. Path sandboxing inside the tools still applies; user approval does not. |

The former `approval` permission mode was removed. New `approval` values are
rejected rather than silently upgraded to `bypass`; existing persisted sessions
using it are restored safely as `plan`. For human review before writes, use the
separate plan workflow.

Changing the mode mid-turn aborts the in-flight turn with
`PermissionModeChangedError` (an `AbortError` subclass), so a turn can never
straddle two policies.

Mode is inspected and changed over HTTP with
`GET|PUT /api/sessions/:id/permission-mode`, and pending requests are resolved
with `POST /api/sessions/:id/permissions/:requestId`.

### 1.1 Model-initiated mode requests

Interactive clients may advertise the `request_permission_mode` tool so the
model can ask for an escalation instead of stopping to ask in prose. The tool is
a **request**, not an escalation primitive:

- its `execute` never touches the `PermissionManager`; it only returns a
  `modeRequest` payload,
- the loop projects that payload as a `permission_mode_requested` event,
- the client renders a confirmation card and only the user's `A` calls
  `setMode()`; `D`/Enter/Esc keep the current mode,
- the tool is read-only for the policy analyzer, so plan mode can ask to leave
  plan mode without a chicken-and-egg denial,
- subagents never receive it (`SESSION_ONLY_TOOL_NAMES` in `src/subagent/tool.ts`),
- the CLI and HTTP entry points do not advertise it (`modeRequest` off); only
  clients that can render the card opt in — the Ink TUI and the headless
  `tui-core` runtime (`TurnRunner.resolveModeRequest`),
- the system prompt names it **only** when the resolved tool provider advertises
  it (`toolProviderAdvertisesModeRequest` in `src/loop.ts`). The guidance used to
  live in the shared `MODE_SUFFIX`, which made the CLI, HTTP and every subagent
  instruct the model to call a tool they could not see,
- asking for the mode already active never opens a card.

Accepted switches are not auto-reverted; the session stays in the new mode
until the user changes it. Because a mid-turn switch aborts the turn, a request
accepted while the turn is still streaming is applied when that turn ends.

Every accepted switch is audited through `PermissionManager.onModeChange` with
`source: "model_request"` plus the model's reason, so an audit log can tell a
human-initiated `Shift+Tab` apart from a model request the human confirmed.
Audit sinks that throw cannot fail the policy change they record.

## 2. Default tool permission matrix

A high-risk call is blocked in `plan` and auto-allowed in `bypass`. Human review
is provided by the separate plan workflow, not by a per-tool permission mode.

| Tool | Category | `plan` | `bypass` | Notes |
|---|---|---|---|---|
| `read`, `ls`, `list`, `grep`, `find`, `search` | Workspace read | allowed | allowed | Confined to the workspace root by the tool implementations. |
| `write`, `edit`, `delete`, `mkdir`, `copy`, `move`, `patch`, `document_edit` | Workspace write | **blocked** | allowed | The `WRITE_TOOLS` set in `src/permissions.ts`. |
| `bash` (benign command) | Process | allowed | allowed | Classified by `analyzeShellCommand`. |
| `bash` (dangerous command) | Process | **blocked** | allowed | Destructive/privileged/exfiltration-shaped commands. |
| `validate_workspace` | Process | **blocked** | allowed | Runs the project's own test/typecheck/build commands. |
| `git_status`, `git_diff`, `git_checkpoint`, `git_undo`, `git_branch_isolate` | VCS | allowed | allowed | `git_undo` restores a prior checkpoint; it does not delete history. |
| `TodoWrite` | Session state | allowed | allowed | No filesystem or network effect. |
| `request_permission_mode` | Session state | allowed | allowed | Only asks the human; never changes the mode itself. See §1.1. |
| `web_search`, `fetch_content`, `get_search_content`, `source_check` | Network | allowed | allowed | Egress — see §4. Off unless web-access tools are registered. |
| `codebase_open`, `codebase_search`, `codebase_read`, `codebase_explain` | Network | allowed | allowed | Egress to GitHub / DeepWiki — see §4. |
| **any MCP tool** | Remote | **blocked** | allowed | Always high risk regardless of the name it advertises. |

Two rules matter more than the table:

1. **MCP tools are never trusted by name.** A remote server that exposes a tool
   called `read` or `bash` is still treated as remote and high risk. Remote
   `annotations` (`readOnlyHint` etc.) are advisory metadata and are never used
   as an authorization decision.
2. **Path confinement is independent of mode.** Even in `bypass`, the workspace
   tools resolve and reject paths outside the workspace root; `bypass` only
   removes the *approval* step.

## 3. Shell sandboxing

`bash` can run through a sandbox runner (`src/sandbox/`). Defaults from
`DEFAULT_SANDBOX_CONFIG`:

| Setting | Default |
|---|---|
| `enabled` | `true` |
| `type` | `auto` (Docker → Podman → in-process Node runner → none) |
| `allowNetwork` | **`false`** |
| `cpuLimit` | `1.0` |
| `memoryLimit` | `512m` |
| `timeout` | `30000` ms |

Note the asymmetry worth understanding before deploying: the sandbox denies
network by default, but a server started without a sandbox runner resolves
`sandboxMode` to `disabled`, in which case `bash` runs as the host user with the
host's network. Set an explicit `sandbox` / `sandboxRunner` for untrusted work.

## 4. Network egress

Three subsystems can reach the network. None of them is enabled implicitly by
the core loop.

| Subsystem | Destination | Gate |
|---|---|---|
| Model providers | The configured provider `baseUrl` | Always on — this is the LLM call itself. Honors `HTTP(S)_PROXY` via the proxy agents. |
| Web access tools | Search provider + fetched pages | Only when `createWebAccessTools` is registered. Per-call `domainFilter` narrows a search. |
| Codebase tools | `github.com`, DeepWiki | `EXTERNAL_CODEBASE_ENABLED` (default on). `GET /api/config` reports `externalCodebase.allowedHosts`. |
| MCP servers | Whatever the server contacts | `MINI_AGENT_MCP_CONFIG` declares servers; nothing runs unless configured. |

**Known gap:** there is currently no global outbound allowlist. `domainFilter`
is per-call and advisory, and MCP servers are unconstrained subprocesses/URLs
once configured. Deployments handling untrusted prompts should enforce egress at
the container or network layer rather than relying on the agent.

## 5. Hardening checklist for untrusted input

- Keep the default `plan` mode; use the plan workflow for human review and grant `bypass` only for trusted execution.
- Provide an explicit sandbox runner so `bash` is containerized with
  `allowNetwork: false`.
- Leave `MINI_AGENT_MCP_AUTO_APPROVE` unset — setting it to `1` removes the
  approval prompt for every remote tool. Prefer `MINI_AGENT_MCP_ALLOW` (or
  `--allow-mcp server[/tool]`) to approve one server or one tool.
- Restrict `EXTERNAL_CODEBASE_ENABLED=0` if repository fetching is not needed.
- Run the process with a workspace-scoped user and enforce egress rules
  externally.
- Audit tool execution via the `onToolExecutionAudit` hook; every call routes
  through `ToolExecutionBroker`.
