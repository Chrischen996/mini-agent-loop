# Agent Instructions

## Project

`mini-agent-loop` is an educational Pi-style coding-agent runtime in TypeScript. The main flow is user prompt → LLM → validated tool calls → tool results → next LLM turn. Major areas:

- `src/loop.ts`, `src/types.ts`, `src/context.ts`: agent loop, messages, context management.
- `src/llm/`, `src/pi-ai/`: provider/model configuration and streaming adapters.
- `src/tools/`: local tools, workspace sandboxing, Git, validation, and TodoWrite.
- `src/cli.ts`, `src/server.ts`, `src/tui/`: one-shot CLI, Express/NDJSON server, and the Ink terminal client. Keep shared loop/tool/session contracts in the core; client-specific rendering/input belongs in its client layer.
- `src/plan/`, `src/plan-act/`: saved plan workflow and execution state machine.
- `src/subagent/`, `src/orchestration/`: nested agents and background coordination.
- `src/mcp/`, `src/codebase/`, `src/web-access/`: explicitly configured external integrations.
- `test/`: Node built-in test-runner tests using scripted faux models; `dist/` is generated and ignored.

Read `README.md` before changing CLI/TUI behavior, permissions, plans, MCP, providers, or environment configuration. Read `docs/build-agent-guide.md` before changing the public agent-building/SDK patterns.

## Commands

Requirements: Node.js `>=22.19.0`. Use the repository scripts from this directory:

```bash
npm install
npm test                                      # offline full suite
npx tsx --test test/loop.test.ts              # focused test example
npm run typecheck                             # strict TypeScript check
npm run build                                 # Vite/Node22 bundle to dist/
npm run tui                                   # the sole Ink/React terminal UI
npm run dev                                   # watch Express server
```

There is no configured lint script. Tests do not require an API key; live CLI/TUI/server runs need a supported provider key in the environment or ignored `.env` file.

## Editing rules and invariants

- TypeScript is strict and uses NodeNext resolution. Preserve explicit local `.ts` import extensions and `async`/streaming behavior.
- Validate tool arguments before execution. Tool failures must become `isError` tool-result messages, not crash the loop; every tool call gets a result before the next LLM call; `maxTurns` remains a hard stop.
- Treat workspace boundaries and symlink protection as security constraints. Do not weaken permission checks, sandboxing, MCP opt-in, or path validation to make a test pass.
- Permission modes are `plan` (default, analysis/read-only) and `bypass`; keep behavior consistent across CLI, server, and TUI.
- The sole terminal UI is the Claude Code-style Ink/React client (`npm run tui`, `src/tui/ink-main.tsx`, `dist/tui.js`). Do not reintroduce a pi-tui, raw-ANSI, or legacy TUI entrypoint. The incremental stdout adapter must not emit full-screen `ESC[2J` clears while streaming.
- Keep the Ink UI's reducer, permissions, commands, session persistence, and core agent loop in sync. Reuse `status-line.ts`, `slash-commands.ts`, `picker-window.ts`, `markdown-lines.ts`, `loading.ts`, `claude-style.ts`, and `welcome-panel.ts` for its presentation chrome.
- Empty-prompt hints resolve once in `promptPlaceholder` (input-utils.ts) and are rendered by `PromptInput.placeholder`. The prompt pointer remains bold; the live activity marker uses the running color.
- The model picker owns its query: `openModelPicker` sets the input to the bare search text so the empty prompt can show `Search models`, and Enter routes it through `modelCommandFromPickerInput` (model-command.ts) so a typed reference switches the model instead of being submitted as a prompt.
- TUI notices and status strings are English at the source. `noticeTitle`/`noticeText`/`statusLabel` only translate legacy Chinese strings recovered from persisted sessions; never add new user-facing Chinese text, and never let a translation fallback blank a message body.
- Tool calls render as compact Claude-style rows (`✓ Name(args)` plus a nested `⎿` result gutter) in the Ink client — no full-width boxes. Live work shows exactly one spinner row; fold transient tips into it rather than stacking another.
- Run focused tests for touched modules, then `npm test`, `npm run typecheck`, and `npm run build` when changes affect runtime or packaging.
