# Kimi K3 Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `moonshotai/kimi-k3` and `moonshotai-cn/kimi-k3` discoverable through `/model` and route requests with K3's regional endpoints and wire format.

**Architecture:** Keep the generated pi-ai provider catalogs unchanged. Add two project-owned typed fallback models, merge them after the upstream catalog with an upstream-first `provider/id` key, and let the already-registered Moonshot providers stream the fallback model objects. Explicit K3 compatibility metadata selects `max_completion_tokens`, OpenAI `reasoning_effort`, image input, and the documented three K3 effort values.

**Tech Stack:** TypeScript, vendored pi-ai OpenAI Completions transport, Node test runner, README Markdown.

---

### Task 1: Lock K3 catalog and wire behavior with failing tests

**Files:**
- Modify: `test/models.test.ts`
- Modify: `test/llm.test.ts`

- [x] **Step 1: Add catalog/search assertions**

Add a test that filters `getAllModels()` for `provider` `moonshotai` or `moonshotai-cn` and `id` `kimi-k3`, then asserts exactly two qualified references, the regional base URLs, `contextWindow` `1048576`, `maxTokens` `131072`, reasoning, text/image input, tools, costs, K3 compatibility overrides, and the `minimal`/`medium`/`xhigh`/`off` thinking map. Assert `searchModels("k3")` returns both qualified references and both qualified exact references resolve. Update the generated catalog size assertion from `1075` to `1077`.

- [x] **Step 2: Add the OpenAI-compatible wire assertion**

Add a `completeChat` test using `makeLlmConfig` with `moonshotai/kimi-k3` and a mocked `fetch`. Assert the request URL is `https://api.moonshot.ai/v1/chat/completions`, the body has `model: "kimi-k3"`, `max_completion_tokens: 131072`, and a K3 value such as `reasoning_effort: "high"`; assert `max_tokens` and `thinking` are absent. Repeat the same endpoint/model checks for `moonshotai-cn/kimi-k3` in the same test or a second focused test.

- [x] **Step 3: Run the focused tests and confirm RED**

Run:

```powershell
node --test test/models.test.ts test/llm.test.ts
```

Expected: the existing tests run, while the new K3 catalog and wire assertions fail because no `kimi-k3` fallback is registered yet.

### Task 2: Implement project-owned K3 fallback registration

**Files:**
- Create: `src/kimi-k3-models.ts`
- Modify: `src/models.ts`

- [x] **Step 1: Define the two typed fallback models**

Create `KIMI_K3_MODELS` with two `Model<"openai-completions">` values:

```ts
{
  id: "kimi-k3",
  name: "Kimi K3",
  api: "openai-completions",
  provider: "moonshotai" | "moonshotai-cn",
  baseUrl: "https://api.moonshot.ai/v1" | "https://api.moonshot.cn/v1",
  reasoning: true,
  input: ["text", "image"],
  contextWindow: 1048576,
  maxTokens: 131072,
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
  compat: {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsReasoningEffort: true,
    maxTokensField: "max_completion_tokens",
    supportsStrictMode: false,
    thinkingFormat: "openai",
  },
  thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "high", high: "high", xhigh: "max", max: "max" },
}
```

- [x] **Step 2: Merge fallbacks after the upstream catalog**

Import `KIMI_K3_MODELS` in `src/models.ts`. Before `toModelRef`, merge `piRuntime.getModels()` followed by the fallback list into a map keyed by lower-cased `${provider}/${id}`. Keep the first entry for each key so an upstream model wins and a future upstream K3 entry does not create a duplicate. Map the merged list to `ModelRef` as before.

- [x] **Step 3: Run the focused tests and confirm GREEN**

Run:

```powershell
node --test test/models.test.ts test/llm.test.ts
```

Expected: all focused tests pass, including the new K3 search, resolution, metadata, regional endpoint, and request-field assertions.

### Task 3: Document selection and verify the complete change

**Files:**
- Modify: `README.md`

- [x] **Step 1: Add regional K3 examples**

In the model-provider examples, document `MOONSHOT_API_KEY` and the two qualified selectors:

```bash
export MOONSHOT_API_KEY=sk-...
export OPENAI_MODEL=moonshotai/kimi-k3       # international endpoint
# or: export OPENAI_MODEL=moonshotai-cn/kimi-k3  # China endpoint
```

Keep the existing provider key documentation authoritative and explain that `/model moonshotai/kimi-k3` and `/model moonshotai-cn/kimi-k3` are the unambiguous TUI references.

- [x] **Step 2: Run all verification commands**

Run:

```powershell
node --test test/*.test.ts
node node_modules/typescript/bin/tsc --noEmit
git -c safe.directory='C:/项目/mini-agent-loop' diff --check
```

Expected: zero test failures, zero TypeScript errors, and no whitespace errors. Confirm the only changed files are the K3 fallback, model registry/tests, README, and the new plan; preserve the pre-existing TUI image files unchanged.

- [x] **Step 3: Review the final diff**

Inspect `git diff` and verify no generated provider catalog or `src/providers/**` mirror was modified, no duplicate K3 entries are produced, and the request body does not regress to `max_tokens` or `thinking` for K3.
