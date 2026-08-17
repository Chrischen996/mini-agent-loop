# Build a Coding Agent (Grok Build style)

This shows how to create a specialized coding agent function using mini-agent-loop.

## Quick Start

```typescript
import { buildAgent } from "./examples/build-agent.ts"

const result = await buildAgent("add rate limiting to the API", {
  cwd: "/path/to/your/project",
})

console.log(result.text)  // what the agent produced
console.log(result.turns) // how many turns it took
```

## How It Works

### 1. Core pieces you need

| Piece | Source | Purpose |
|-------|--------|---------|
| `runAgentLoop` | `src/loop.ts` | The main agent loop — takes text + options, returns messages |
| `createTools(cwd)` | `src/tools/index.ts` | File read/write/grep/bash tools |
| `loadLlmConfigFromEnv()` | `src/llm/config.ts` | Reads `.env` + profiles to get LLM config |
| `createSubagentTool()` | `src/subagent/index.ts` | Spawns child agents for parallel work |
| `coderProfile` | `src/subagent/profiles.ts` | Pre-configured coding agent persona |

### 2. Minimal version (no subagents)

```typescript
import { runAgentLoop } from "./src/loop.ts"
import { createTools } from "./src/tools/index.ts"
import { loadLlmConfigFromEnv } from "./src/llm/config.ts"

const llm = loadLlmConfigFromEnv()
const tools = createTools(process.cwd(), { allowWrite: true })

const messages = await runAgentLoop("write a hello world script", {
  llm,
  tools,
  maxTurns: 10,
})

const answer = messages.at(-1)?.content
```

### 3. With subagent delegation

```typescript
import { createSubagentTool } from "./src/subagent/index.ts"
import { coderProfile } from "./src/subagent/profiles.ts"

const subagent = createSubagentTool({
  parentLlm: llm,
  parentTools: tools,
  profiles: [coderProfile],
  maxDepth: 3,
})

const messages = await runAgentLoop("refactor auth module", {
  llm,
  tools: [...tools, subagent],
  autoSubagent: { enabled: true, minScore: 2 },
})
```

## Profiles

Pre-built personas in `src/subagent/profiles.ts`:

- **`researcher`** — read-only, searches and analyzes code
- **`coder`** — writes and edits files
- **`reviewer`** — reviews code for bugs/style (read-only)

You can add your own by creating a `SubagentProfile` object and passing it to `createSubagentTool`.

## Creating a Custom Profile

```typescript
import type { SubagentProfile } from "./src/subagent/types.ts"

const myProfile: SubagentProfile = {
  name: "test-writer",
  description: "Writes and runs unit tests",
  systemPrompt: `You are a testing specialist. Write tests, run them, fix failures.`,
  allowedTools: ["read", "write", "edit", "bash"],
  maxTurns: 15,
}

const subagent = createSubagentTool({
  parentLlm: llm,
  parentTools: tools,
  profiles: [coderProfile, myProfile],
})
```

## Key Files to Customize

| What you want to change | Edit this |
|------------------------|-----------|
| System prompt | Pass `systemPrompt` option to `runAgentLoop` |
| Which tools are available | Filter `tools` array before passing in |
| Max turns / depth | `maxTurns` and `maxDepth` options |
| LLM model | Set `OPENAI_MODEL` env var or pass `llm` config |
| Auto-delegation triggers | Tune `autoSubagent.minScore` (higher = less aggressive) |

## Deploying as a Package

```bash
# Publish to npm
npm run build
npm publish
```

Then users can do:
```typescript
import { buildAgent } from "@your-scope/mini-agent-build"

const result = await buildAgent("your task here")
```
