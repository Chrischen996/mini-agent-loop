# Security model: permissions, sandboxing, and egress

This document is the authoritative reference for **which tools can do what, in
which permission mode, and what reaches the network**. It exists because Mini
Agent ships a shell tool, container/process sandboxes, and MCP clients in the
same runtime; operators need a single place that states the defaults.

## 1. Permission modes

Sessions run in one of three modes (`src/permissions.ts`). All entry points
(CLI, TUI, HTTP) default to **`plan`** unless `MINI_AGENT_PERMISSION_MODE` or an
explicit option overrides it.

| Mode | Intent | Behavior |
|---|---|---|
| `plan` | Analysis only (default) | Read-only tools run freely. Writes, `validate_workspace`, dangerous shell, and **every** MCP tool are blocked as high risk. |
| `approval` | Human-in-the-loop | Same risk classification as `plan`, but high-risk calls raise a `PermissionRequest` the user can allow or deny. An allowed `(tool, args)` pair is remembered for the rest of the session. |
| `bypass` | Trusted automation | Every tool auto-allows. Path sandboxing inside the tools still applies; user approval does not. |

Changing the mode mid-turn aborts the in-flight turn with
`PermissionModeChangedError` (an `AbortError` subclass), so a turn can never
straddle two policies.

Mode is inspected and changed over HTTP with
`GET|PUT /api/sessions/:id/permission-mode`, and pending requests are resolved
with `POST /api/sessions/:id/permissions/:requestId`.

## 2. Default tool permission matrix

"Approval" below means the call is high risk: blocked in `plan`, prompted in
`approval`, auto-allowed in `bypass`.

| Tool | Category | `plan` | `approval` | Notes |
|---|---|---|---|---|
| `read`, `ls`, `list`, `grep`, `find`, `search` | Workspace read | allowed | allowed | Confined to the workspace root by the tool implementations. |
| `write`, `edit`, `delete`, `mkdir`, `copy`, `move`, `patch`, `document_edit` | Workspace write | **blocked** | approval | The `WRITE_TOOLS` set in `src/permissions.ts`. |
| `bash` (benign command) | Process | allowed | allowed | Classified by `analyzeShellCommand`. |
| `bash` (dangerous command) | Process | **blocked** | approval | Destructive/privileged/exfiltration-shaped commands. |
| `validate_workspace` | Process | **blocked** | approval | Runs the project's own test/typecheck/build commands. |
| `git_status`, `git_diff`, `git_checkpoint`, `git_undo`, `git_branch_isolate` | VCS | allowed | allowed | `git_undo` restores a prior checkpoint; it does not delete history. |
| `TodoWrite` | Session state | allowed | allowed | No filesystem or network effect. |
| `web_search`, `fetch_content`, `get_search_content`, `source_check` | Network | allowed | allowed | Egress — see §4. Off unless web-access tools are registered. |
| `codebase_open`, `codebase_search`, `codebase_read`, `codebase_explain` | Network | allowed | allowed | Egress to GitHub / DeepWiki — see §4. |
| **any MCP tool** | Remote | **blocked** | approval | Always high risk regardless of the name it advertises. |

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

- Keep the default `plan` mode; grant `approval` per session, never `bypass`.
- Provide an explicit sandbox runner so `bash` is containerized with
  `allowNetwork: false`.
- Leave `MINI_AGENT_MCP_AUTO_APPROVE` unset — setting it to `1` removes the
  approval prompt for remote tools.
- Restrict `EXTERNAL_CODEBASE_ENABLED=0` if repository fetching is not needed.
- Run the process with a workspace-scoped user and enforce egress rules
  externally.
- Audit tool execution via the `onToolExecutionAudit` hook; every call routes
  through `ToolExecutionBroker`.
