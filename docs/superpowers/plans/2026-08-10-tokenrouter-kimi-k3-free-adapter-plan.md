# TokenRouter Kimi K3 Free Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Make `tokenrouter/kimi-k3-free` discoverable and usable through the TUI and CLI.

**Architecture:** Add one project-owned typed fallback model, merge it after the generated pi-ai catalog, and reuse the existing OpenAI Completions transport. Explicit compatibility metadata selects `max_tokens` and disables unsupported reasoning/developer/strict fields.

**Tech Stack:** TypeScript, vendored pi-ai OpenAI Completions transport, Node test runner, README Markdown.

---

### Task 1: Lock TokenRouter catalog and wire behavior with failing tests

**Files:**
- Modify: `test/models.test.ts`
- Modify: `test/llm.test.ts`

- [x] **Step 1: Add the catalog/search assertion**

Add a test that finds exactly `tokenrouter/kimi-k3-free` in `getAllModels()` and asserts:

```ts
assert.equal(model.provider, "tokenrouter");
assert.equal(model.baseUrl, "https://api.tokenrouter.io/v1");
assert.deepEqual(model.apiKeyEnv, ["TOKENROUTER_API_KEY"]);
assert.deepEqual(model.capabilities.input, ["text"]);
assert.equal(model.capabilities.tools, true);
assert.equal(model.reasoning, false);
assert.equal(model.contextWindow, 128000);
assert.equal(model.maxTokens, 16384);
assert.deepEqual(model.compat, {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  maxTokensField: "max_tokens",
  supportsStrictMode: false,
  thinkingFormat: "openai",
});
```

Assert `getAvailableModels({ TOKENROUTER_API_KEY: "test" })` includes the
model, `searchModels("kimi-k3-free")` includes the qualified reference, and
`resolveModel("tokenrouter/kimi-k3-free")` keeps the TokenRouter endpoint.
Update the generated catalog count for the one fallback model.

- [x] **Step 2: Add the OpenAI-compatible wire assertion**

Add a mocked `fetch` test using `makeLlmConfig` with
`tokenrouter/kimi-k3-free` and `https://api.tokenrouter.io/v1`. Assert:

```ts
assert.equal(requestUrl, "https://api.tokenrouter.io/v1/chat/completions");
assert.equal(new Headers(requestInit?.headers).get("authorization"), "Bearer tr-test-key");
assert.equal(requestBody?.model, "kimi-k3-free");
assert.equal(requestBody?.max_tokens, 16384);
assert.equal(requestBody?.max_completion_tokens, undefined);
assert.equal(requestBody?.reasoning_effort, undefined);
assert.equal(requestBody?.thinking, undefined);
```

- [x] **Step 3: Run the focused tests and confirm RED**

Run:

```powershell
node node_modules/tsx/dist/cli.mjs --test test/models.test.ts test/llm.test.ts
```

Expected: the new catalog and wire assertions fail because the TokenRouter
fallback is not registered yet.

### Task 2: Implement the TokenRouter fallback registration

**Files:**
- Create: `src/tokenrouter-models.ts`
- Modify: `src/models.ts`

- [x] **Step 1: Define the typed fallback model**

Create `TOKENROUTER_MODELS` with one `Model<"openai-completions">`:

```ts
{
  id: "kimi-k3-free",
  name: "Kimi K3 Free (TokenRouter)",
  api: "openai-completions",
  provider: "tokenrouter",
  baseUrl: "https://api.tokenrouter.io/v1",
  reasoning: false,
  input: ["text"],
  contextWindow: 128000,
  maxTokens: 16384,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  compat: {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    maxTokensField: "max_tokens",
    supportsStrictMode: false,
    thinkingFormat: "openai",
  },
}
```

- [x] **Step 2: Register the provider key and merge the fallback**

Add `tokenrouter: ["TOKENROUTER_API_KEY"]` to `PROVIDER_ENV_KEYS`. Import
`TOKENROUTER_MODELS` and merge `piRuntime.getModels()` followed by both K3
fallback lists before `toModelRef`, preserving upstream-first de-duplication.

- [x] **Step 3: Run the focused tests and confirm GREEN**

Run the same focused test command. Expected: all model and wire assertions
pass, including the `max_tokens` and no-reasoning-field checks.

### Task 3: Document and verify the fixed route

**Files:**
- Modify: `README.md`

- [x] **Step 1: Document the TokenRouter environment and selector**

Add `TOKENROUTER_API_KEY` to the environment table and a TokenRouter section:

```bash
export TOKENROUTER_API_KEY=tr_...
export OPENAI_MODEL=tokenrouter/kimi-k3-free
```

Explain that the qualified TUI selector is `/model tokenrouter/kimi-k3-free`
and that the project sends the fixed model id `kimi-k3-free` through
`https://api.tokenrouter.io/v1/chat/completions`.

- [x] **Step 2: Run verification**

Run:

```powershell
node node_modules/tsx/dist/cli.mjs --test test/models.test.ts test/llm.test.ts
node node_modules/typescript/bin/tsc --noEmit
git -c safe.directory='C:/项目/mini-agent-loop' diff --check
```

The focused tests and typecheck must pass. Any unrelated full-suite Windows
failures should be reported separately from this adapter.

- [x] **Step 3: Review the final diff**

Confirm no generated provider catalog or `src/providers/**` mirror was
modified, the fixed wire model id is not rewritten, and the pre-existing TUI
image attachment changes remain untouched.
