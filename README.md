# Mini Tool Agent (Phases 1–3)

Educational rebuild of a Pi-style agent loop. Focus is control flow, not a full product.

```text
user prompt
  -> LLM (may return tool_calls)
  -> for each tool_call (sequential):
       validate args
       execute tool
       append tool result message
  -> LLM again
  -> stop when assistant has no tool_calls
```

## Requirements

- Node.js 18+
- An OpenAI-compatible API key (for real model runs)

## Setup

```bash
cd mini-agent
npm install
```

### Environment

| Variable | Required | Default |
|---|---|---|
| `OPENAI_API_KEY` | yes\* | — |
| `DEEPSEEK_API_KEY` | yes\* (DeepSeek alt) | — |
| `GEMINI_API_KEY` | no | — |
| `DASHSCOPE_API_KEY` | no | — |
| `ZHIPU_API_KEY` | no | — |
| `MOONSHOT_API_KEY` | no | — |
| `XAI_API_KEY` | no | — |
| `MISTRAL_API_KEY` | no | — |
| `GROQ_API_KEY` | no | — |
| `OPENROUTER_API_KEY` | no | — |
| `SILICONFLOW_API_KEY` | no | — |
| `OPENAI_BASE_URL` | no | OpenAI or DeepSeek auto |
| `OPENAI_MODEL` | no | `gpt-4o-mini` / `deepseek-chat` |
| `MINI_AGENT_MODELS` | no | — |
| `VISION_API_KEY` | no\* | — |
| `VISION_BASE_URL` | no\* | — |
| `VISION_MODEL` | no\* | — |
| `VISION_PROVIDER` | no | `openai-compatible` / `zhipu` |
| `ZHIPU_API_KEY` | no\* | — |
| `VISION_RETRIES` | no | `1` |
| `VISION_RETRY_DELAY_MS` | no | `1000` |
| `VISION_FALLBACK_MODEL` | no | — |

\* Real runs need at least one supported provider key.
`/model` only lists
models whose declared key is configured.
The vision variables are optional. For the generic provider, the three
`VISION_API_KEY`, `VISION_BASE_URL`, and `VISION_MODEL` values must be set
together. When configured, images sent to a text-only main model are analyzed
first by the vision model. Without them, the existing `IMAGE_POLICY`
degradation applies.

#### OpenAI

```bash
export OPENAI_API_KEY=sk-...
# optional:
# export OPENAI_BASE_URL=https://api.openai.com/v1
# export OPENAI_MODEL=gpt-4o-mini
```

#### DeepSeek (recommended for local teaching in CN)

DeepSeek’s chat API is OpenAI-compatible and supports tool calling via `deepseek-chat`.

```bash
# simplest: only DeepSeek key (base URL + model auto-fill)
export DEEPSEEK_API_KEY=sk-...

# or explicit OpenAI-compatible vars:
export OPENAI_API_KEY=sk-...          # your DeepSeek key
export OPENAI_BASE_URL=https://api.deepseek.com/v1
export OPENAI_MODEL=deepseek-chat
```

**Recommended for agent shells:** put the key in `mini-agent/.env` (gitignored). CLI loads it automatically:

```bash
# mini-agent/.env
DEEPSEEK_API_KEY=sk-...
```

Get a key at [https://platform.deepseek.com](https://platform.deepseek.com). Prefer `deepseek-chat` (not `deepseek-reasoner`) for tool loops.

#### Model providers

The main transport supports OpenAI Chat Completions compatible APIs. The built-in
catalog includes OpenAI, DeepSeek, Google Gemini's OpenAI-compatible endpoint,
DashScope/Qwen, Zhipu GLM, Moonshot/Kimi, xAI, Mistral, Groq, OpenRouter, and
SiliconFlow. Configure a provider key and run the Ink TUI, then use `/model`:

```bash
npm run tui:ink

# examples inside the TUI
/model
/model deepseek-chat
/model google/gemini-2.5-pro
/model openrouter/anthropic/claude-sonnet-4
```

Claude entries use OpenRouter because Anthropic's native Messages API is not the
same wire protocol. A model is not shown merely because it exists in the static
catalog; its provider key must be configured.

For a new model or private OpenAI-compatible gateway, add it without changing
source code:

```bash
CUSTOM_LLM_KEY=sk-...
MINI_AGENT_MODELS='[{"provider":"company","id":"company-model-v1","baseUrl":"https://llm.example/v1","apiKeyEnv":"CUSTOM_LLM_KEY","input":["text"],"tools":true,"contextWindow":128000}]'
```

`MINI_AGENT_MODELS` is a JSON array. Each entry requires `provider`, `id`,
`baseUrl`, and `apiKeyEnv`; optional fields are `input`, `tools`, and
`contextWindow`.

#### Vision preprocessing for DeepSeek

DeepSeek remains the text reasoning model. A separate OpenAI-compatible vision
model converts images into structured observations before DeepSeek is called.
The adapter is provider-neutral; for example, a DashScope-compatible Qwen VL
configuration can be placed in `.env`:

```bash
DEEPSEEK_API_KEY=sk-...
OPENAI_MODEL=deepseek-chat

VISION_API_KEY=sk-...
VISION_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
VISION_MODEL=qwen-vl-plus
```

For Zhipu's OpenAI-compatible vision endpoint, the preset can be used with
only the provider key; override `VISION_MODEL` when your account exposes a
different current GLM vision model:

```bash
DEEPSEEK_API_KEY=sk-...
OPENAI_MODEL=deepseek-chat
VISION_PROVIDER=zhipu
ZHIPU_API_KEY=...
# optional:
# VISION_MODEL=glm-4v-plus
```

```text
user/tool images
  -> VisionPreprocessor (all new images in one batch)
  -> structured vision analysis
  -> DeepSeek (text only)
```

If the vision request fails, times out after 60 seconds, or returns empty
content, the turn fails before DeepSeek is called. Temporary 429/5xx/network
errors are retried once by default. Set `VISION_FALLBACK_MODEL` to try another
vision model after those retries; fallback is opt-in to avoid unexpected API
usage.

## Run

**Important:** scripts live in `mini-agent/package.json`. Always `cd` into `mini-agent` first.
If you run from the parent folder (`agent loop/`), npm reports `Missing script: "start"`.

```bash
cd "/Users/chenjiaxu/Project/agent loop/mini-agent"

# offline unit tests (no key)
npm test
npm run typecheck

# live agent (needs API key in .env or export)
npm start -- "用一句话介绍你自己"
npm start -- "读取 package.json 并总结项目名"
npm start -- "描述图片并提取可见文字" --image ./shot.png
npm start -- "比较两张图片" --image ./a.png --image ./b.png

# equivalent without npm script:
npx tsx src/cli.ts "读取 package.json 并总结项目名"
```

Do **not** write `npm start ` with a trailing space in the script name, and keep the `--` before the prompt so npm forwards args to the CLI.

Events (`assistant` / `tool_start` / `tool_end` / `done`) log to stderr; final assistant text prints to stdout.

## GUI chat

The GUI keeps model credentials and file tools in a local Node server. The
browser receives sanitized text/tool events and never receives API keys or
image base64 from the agent history.

```bash
# development: API on 127.0.0.1:3001, GUI on 127.0.0.1:5173
npm run dev

# production build, then serve GUI + API together on 127.0.0.1:3001
npm run build
npm run serve
```

Optional server environment:

```bash
PORT=3001
AGENT_WORKSPACE=/absolute/path/to/workspace
```

The chat supports multi-turn sessions, workspace file-tree path references,
up to five images per message, file selection or clipboard image paste, tool
activity events, Markdown rendering, and new-session reset. Selecting a file in
the sidebar only adds a path reference; the agent still uses the `read` tool to
load contents. Sessions are kept in memory and are cleared when the server
restarts.

The tool registry follows Pi Agent's seven-tool vocabulary:

- `read`: read text files and supported images.
- `bash`: execute commands in the workspace with timeout and cancellation.
- `edit`: apply exact unique replacements using `path` and `edits[]`.
- `write`: create or overwrite UTF-8 text files.
- `grep`: regex/literal content search with glob, case, and context options.
- `find`: find files by glob pattern.
- `ls`: list directory contents, including dotfiles.

The default active set is Pi's `read`, `bash`, `edit`, and `write`. CLI users
can opt into the read-only tools with `--tools grep,find,ls`, or remove tools
with `--exclude-tools bash`. SDK/server callers can pass the equivalent
selection to `createDefaultTools`.

All tools still use relative paths and reject paths that escape the configured
workspace or resolve through an outside symlink. `.git` and `node_modules`
remain protected by the workspace sandbox.

Local API:

```text
GET    /api/health
GET    /api/config
GET    /api/workspace/list?path=   lazy directory listing (workspace sandbox)
POST   /api/sessions
GET    /api/sessions/:id
DELETE /api/sessions/:id
POST   /api/sessions/:id/messages  multipart(prompt, referencedPaths, images) -> NDJSON stream
```

## Terminal TUI

The Ink terminal client uses the same Agent Core and tool registry as the CLI
and Web GUI. It supports streaming output, tool activity, file completion, and
the local `/model` selector:

```bash
npm run tui
```

Use `/model`, `/clear`, `/quit`, or `Ctrl+C` inside the terminal client. The
previous dependency-free ANSI client remains available as `npm run tui:legacy`.

## Test (offline)

Uses Node’s built-in test runner + a scripted faux model (no API key):

```bash
npm test
```

Coverage includes:

- Happy path: user → assistant(toolCalls) → tool → assistant(text)
- Tool call id ↔ tool result pairing
- Unknown tool → `isError` tool message (no crash)
- Validation failure → `isError` tool message (no crash)
- `maxTurns` hard stop
- `read` sandbox / missing file behavior
- symlink escape rejection
- vision/non-vision message preparation
- provider-specific API key selection
- pluggable message preprocessing
- batched vision analysis before text-only model calls
- vision failure prevents an unsupported model from guessing

## Layout

```text
mini-agent/
  package.json
  tsconfig.json
  src/
    types.ts
    llm.ts
    content.ts
    models.ts
    preprocessors/
      types.ts
      vision.ts
      index.ts
    validate.ts
    loop.ts
    cli.ts
    server.ts
    tools/
      types.ts
      read.ts
      index.ts
  test/
    faux-model.ts
    loop.test.ts
    vision.test.ts
    server.test.ts
  web/
    src/
      App.tsx
      styles.css
    vite.config.ts
  README.md
```

## Invariants

1. Validate tool args before execute
2. Tool failure is a **message** (`isError`), not a loop crash
3. Every tool call gets a tool result before the next LLM call
4. Loop stops when assistant has zero tool calls
5. `maxTurns` hard-stops runaway loops

## Non-goals (this teaching cut)

Streaming, general extension loading, parallel tools, permission UI, MCP,
session tree, multi-provider registry.
