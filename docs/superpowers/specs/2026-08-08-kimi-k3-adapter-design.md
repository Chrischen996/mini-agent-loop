# Kimi K3 Moonshot Adapter Design

**Status:** Approved on 2026-08-08

## Context

The project already exposes the `moonshotai` and `moonshotai-cn` providers through the vendored pi-ai runtime, but its generated catalog stops at Kimi K2.7 Code. Kimi K3 is available from both Moonshot OpenAI-compatible endpoints and should appear as a normal built-in model in the TUI and CLI.

The generated provider files explicitly say not to edit them manually, and this repository does not include their generator. The adapter will therefore live in project-owned code and act as a fallback until the upstream catalog contains Kimi K3.

## Goals

- Register `moonshotai/kimi-k3` and `moonshotai-cn/kimi-k3` as built-in models.
- Reuse `MOONSHOT_API_KEY` and the existing Moonshot provider transports.
- Send Kimi K3's documented `reasoning_effort` and `max_completion_tokens` request fields.
- Expose text and image input, tool calling, reasoning output, and the 1M-token context window through existing project APIs.
- Keep the local addition idempotent when a future upstream catalog adds the same provider/model pairs.

## Non-Goals

- Do not add the Anthropic-compatible `https://api.moonshot.cn/anthropic` endpoint or the `kimi-k3[1m]` alias.
- Do not modify the separate `kimi-coding` subscription provider.
- Do not add video as a new project capability; the current model type represents only text and image input.
- Do not perform a billed live API request as part of automated verification.
- Do not update the excluded `src/providers` mirror, which is not used by the runtime or TypeScript builds.

## Official Contract

Sources:

- https://platform.kimi.com/docs/guide/kimi-k3-quickstart
- https://platform.kimi.ai/docs/pricing/chat-k3

Kimi K3 uses model id `kimi-k3`. It has a 1,048,576-token context window, accepts text and image input, always reasons, and accepts `low`, `high`, or `max` in the top-level `reasoning_effort` field. The documented default completion limit is 131,072 tokens, while the API permits a larger explicit maximum. Published international rates per million tokens are $0.30 for cache hits, $3.00 for uncached input, and $15.00 for output.

## Architecture

Create `src/kimi-k3-models.ts` with two typed `Model<"openai-completions">` definitions. The definitions differ only in provider id and base URL:

| Qualified model | Base URL |
| --- | --- |
| `moonshotai/kimi-k3` | `https://api.moonshot.ai/v1` |
| `moonshotai-cn/kimi-k3` | `https://api.moonshot.cn/v1` |

`src/models.ts` will merge these project-owned models with `piRuntime.getModels()` before converting them to `ModelRef`. A provider/id key already present in the upstream catalog wins, so a future catalog refresh automatically retires the fallback without creating duplicate selector entries.

The runtime already owns both Moonshot providers. Its dispatch path accepts a typed model object and routes by provider and API, so no new provider implementation or authentication branch is required.

## Model Metadata

Each model will use:

- `id`: `kimi-k3`
- `name`: `Kimi K3`
- `api`: `openai-completions`
- `reasoning`: `true`
- `input`: `text`, `image`
- `contextWindow`: `1048576`
- `maxTokens`: `131072`
- `cost`: input `3`, output `15`, cache read `0.3`, cache write `0`, in the catalog's existing USD-per-million convention

The project sends `maxTokens` on every request and also uses it as the context-compaction reserve. Using the documented default of 131,072 preserves 917,504 tokens for prompt history and avoids requesting a 1M-token completion on every turn.

## Compatibility And Reasoning

Kimi K3 needs model-specific compatibility overrides because the generic Moonshot detection still describes older K2 models:

- `supportsStore: false`
- `supportsDeveloperRole: false`
- `supportsReasoningEffort: true`
- `maxTokensField: "max_completion_tokens"`
- `supportsStrictMode: false`
- `thinkingFormat: "openai"`

Using the OpenAI thinking format sends only `reasoning_effort`; it does not send the older K2 `thinking: { type: ... }` field. Existing response parsing already preserves `reasoning_content` and replays it in multi-turn and tool-call histories.

The project's six provider-neutral effort levels map onto K3's three values:

| Project level | K3 value |
| --- | --- |
| `minimal` | `low` |
| `low` | `low` |
| `medium` | `high` |
| `high` | `high` |
| `xhigh` | `max` |
| `max` | `max` |

`off` maps to `null` because K3 cannot disable reasoning.

## User Flow

With `MOONSHOT_API_KEY` configured, users can select either model with the existing selector:

```text
/model moonshotai/kimi-k3
/model moonshotai-cn/kimi-k3
```

The selected model then follows the existing Moonshot authentication, OpenAI-compatible request, streaming, vision, tool-call, retry, and error-reporting paths. No K3-specific UI state is needed.

## Error Handling

Missing credentials, HTTP errors, malformed responses, network failures, and context overflow continue through existing provider and loop behavior. The adapter adds no fallback between the CN and international endpoints, because silently changing regions could change billing, availability, or data residency.

## Testing

Implementation will follow test-driven development:

1. Add a failing catalog test that expects exactly two qualified K3 entries and verifies provider, base URL, capabilities, context, output limit, price, compatibility, and reasoning maps.
2. Add a failing wire test that selects K3 through the public model/config path, intercepts the request, and verifies `reasoning_effort`, `max_completion_tokens`, model id, and endpoint. It must also verify that `max_tokens` and `thinking` are absent.
3. Add the minimal fallback model definitions and registry merge needed to pass those tests.
4. Update the existing exact catalog-size assertion from 1075 to 1077.
5. Run the focused tests, full test suite, and TypeScript typecheck.

## Documentation

Add Kimi K3 model-selection examples to the README provider section. The existing `MOONSHOT_API_KEY` documentation remains authoritative, so no new environment variable is introduced.

## Acceptance Criteria

- Both qualified K3 model references resolve without `MINI_AGENT_MODELS`.
- The selector returns one K3 entry per Moonshot region and no duplicate fallback when an upstream entry exists.
- K3 requests use the selected regional endpoint, `max_completion_tokens: 131072`, and an allowed K3 reasoning effort.
- K3 requests do not include the obsolete `thinking` field or `max_tokens` field.
- Text, image, and tool capabilities remain enabled through existing adapters.
- Focused tests, the complete test suite, and `npm run typecheck` pass.
