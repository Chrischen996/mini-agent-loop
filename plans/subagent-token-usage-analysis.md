# Subagent Token Usage Analysis

**Project:** mini-agent-loop  
**Date:** 2026-08-18  
**Status:** Current Implementation Assessment

## Executive Summary

The project has a **functional token tracking system** for subagents with basic accumulation and global budget enforcement. However, there are opportunities for improvement in pre-flight validation, detailed breakdowns, cost tracking, and observability.

---

## Current Implementation

### ✅ Core Features Implemented

#### 1. Token Accumulation ([`src/subagent/tool.ts:640-652`](../src/subagent/tool.ts))

```typescript
// Token tracking in subagent execution
onEvent: (event: LoopEvent) => {
  if (event.type === "assistant" && event.usage) {
    const delta = event.usage.totalTokens;
    accumulatedTokens += delta;
    
    if (globalBudgetState) {
      globalBudgetState.used += delta;
      if (globalBudgetState.used > globalBudgetState.limit) {
        throw new Error(`Sub-agent global token budget exceeded`);
      }
    }
  }
}
```

**How it works:**
- Each assistant response reports `usage.totalTokens`
- Subagent maintains local `accumulatedTokens` counter
- Shared `globalBudgetState` tracks cross-subagent usage
- Budget exceeded → immediate error thrown

#### 2. Global Token Budget ([`src/subagent/types.ts:92-96`](../src/subagent/types.ts))

```typescript
export type SubagentToolOptions = {
  globalTokenBudget?: number;           // Total budget (e.g., 100,000)
  globalBudgetState?: {                 // Shared state object
    used: number;                       // Tokens consumed so far
    limit: number;                      // Budget ceiling
  };
  checkGlobalBudget?: (tokens: number) => void;  // Callback hook
};
```

**Design rationale:**
- Prevents runaway token consumption in nested hierarchies
- Shared across parent + all child subagents
- Optional (disabled when undefined)

#### 3. Event Reporting ([`src/subagent/types.ts:285-301`](../src/subagent/types.ts))

```typescript
type SubagentEvent = {
  type: "subagent_end";
  id: string;
  result: string;
  success: boolean;
  depth: number;
  turns: number;
  totalTokens: number;  // ← Cumulative usage reported here
  runtime: SubagentRuntimeInfo;
  errors?: Array<{...}>;
};
```

**Observability points:**
- **CLI:** Logs token usage ([`src/cli.ts:125`](../src/cli.ts))
- **TUI:** Displays per-subagent tokens ([`src/tui/state.ts:738`](../src/tui/state.ts))
- **Server API:** Exposes via HTTP endpoint ([`src/server.ts:362`](../src/server.ts))

#### 4. Test Coverage ([`test/subagent.test.ts:1178-1217`](../test/subagent.test.ts))

```typescript
describe("token tracking", () => {
  it("subagent_end totalTokens is 0 when chat provides no usage info");
  it("subagent_end totalTokens is 0 on error");
  // ✅ Basic scenarios covered
  // ❌ Missing: budget enforcement, batch coordination, nested hierarchies
});
```

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                      Parent Agent                            │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ globalBudgetState: { used: 0, limit: 100000 }        │   │
│  └──────────────────────────────────────────────────────┘   │
│                           │                                   │
│                           ├───────────────┬─────────────┐    │
│                           ▼               ▼             ▼    │
│                  ┌─────────────┐  ┌─────────────┐  ┌──────┐ │
│                  │ Subagent 1  │  │ Subagent 2  │  │  3   │ │
│                  │ researcher  │  │   coder     │  │review│ │
│                  ├─────────────┤  ├─────────────┤  └──────┘ │
│                  │ tokens: 850 │  │ tokens: 1200│           │
│                  └─────────────┘  └─────────────┘           │
│                                           │                   │
│                                           ▼                   │
│                                  ┌─────────────┐             │
│                                  │ Nested Sub  │             │
│                                  │ (depth=2)   │             │
│                                  ├─────────────┤             │
│                                  │ tokens: 450 │             │
│                                  └─────────────┘             │
│                                                               │
│  Final globalBudgetState.used = 850 + 1200 + 450 = 2500     │
└─────────────────────────────────────────────────────────────┘
```

---

## Current Limitations

### ⚠️ 1. No Pre-Flight Budget Validation

**Problem:**
```typescript
// Current: Check AFTER consuming tokens
if (event.type === "assistant" && event.usage) {
  accumulatedTokens += delta;
  if (globalBudgetState.used > globalBudgetState.limit) {
    throw new Error("Budget exceeded");  // ← Already spent!
  }
}
```

**Impact:**
- May exceed budget by one full assistant response before catching
- Wastes tokens on doomed execution

**Recommended fix:**
```typescript
// Before execution starts
if (globalBudgetState && globalBudgetState.used >= globalBudgetState.limit) {
  return {
    content: `Token budget exhausted (${globalBudgetState.limit})`,
    isError: true
  };
}
```

✅ **Already partially implemented** at [`src/subagent/tool.ts:526-531`](../src/subagent/tool.ts)

### ⚠️ 2. Incomplete Provider Support

**Problem:**
- Token tracking depends on `event.usage.totalTokens` from LLM provider
- Not all providers report usage consistently
- Falls back to `0` when unavailable

**Affected providers:**
- ✅ OpenAI: Full support (input/output/cache breakdown)
- ✅ Anthropic: Full support
- ✅ Bedrock: Full support
- ⚠️ Faux (test): Returns 0 or synthetic values
- ⚠️ Some custom providers may not report usage

**Evidence:** [`test/subagent.test.ts:1186`](../test/subagent.test.ts)
```typescript
chat: createImmediateChat("no usage")
// Result: end.totalTokens === 0
```

### ⚠️ 3. No Cost Tracking

**Gap:** Tokens counted but not converted to cost

**Missing:**
- Model-specific pricing (GPT-4: $0.03/1K vs GPT-3.5: $0.001/1K)
- Cache hit discounts (Anthropic: 90% cheaper)
- Reasoning token pricing (different rates)

**Potential impact:**
```typescript
// Same token count, vastly different costs:
researcher: { model: "gpt-4o", tokens: 10000 }      // ~$0.30
coder:      { model: "gpt-3.5-turbo", tokens: 10000 } // ~$0.01
```

### ⚠️ 4. Limited Token Granularity

**Current:** Only `totalTokens` (single number)

**Missing breakdown:**
```typescript
// What we have:
{ totalTokens: 5000 }

// What we need:
{
  input: 3500,
  output: 1200,
  cacheRead: 200,    // Anthropic cache hits
  cacheWrite: 100,   // Cache creation
  reasoning: 300     // Extended thinking tokens (o1/deepseek)
}
```

**Why it matters:**
- Cache hits are 90% cheaper (Anthropic)
- Reasoning tokens have different pricing
- Input vs output have different rates

### ⚠️ 5. No Batch Budget Coordination

**Problem:** `subagent_batch` runs tasks in parallel

```typescript
// Current behavior:
await Promise.all([
  subagent1.execute(),  // Could use 30K tokens
  subagent2.execute(),  // Could use 40K tokens
  subagent3.execute(),  // Could use 35K tokens
]);
// Total: 105K tokens (budget was 100K!) ❌
```

**Missing:**
- Budget allocation per task
- Graceful degradation when budget limited
- Priority-based execution order

---

## Usage Patterns in Codebase

### CLI Integration ([`src/cli.ts:124-125`](../src/cli.ts))

```typescript
case "subagent_end":
  console.error(
    `[subagent_end] id=${event.id} depth=${event.depth} ` +
    `success=${event.success} model=${event.runtime.model} ` +
    `turns=${event.turns} tokens=${event.totalTokens}` +
    `${event.errors?.length ? ` errors=...` : ""}`
  );
```

**Output example:**
```
[subagent_end] id=abc123 depth=1 success=true model=gpt-4o turns=3 tokens=2450
```

### TUI Integration ([`src/tui/state.ts:737-738`](../src/tui/state.ts))

```typescript
case "subagent_end": {
  return {
    ...m,
    turns: evt.turns,
    totalTokens: evt.totalTokens || undefined,
    durationMs: now - m.startedAt,
  };
}
```

Visual display includes token badge in subagent card.

### Server API Integration ([`src/server.ts:361-363`](../src/server.ts))

```typescript
case "subagent_end":
  return {
    type: "subagent_end",
    // ...
    turns: event.turns,
    totalTokens: event.totalTokens,
    resultPreview: event.result.slice(0, 300),
  };
```

Exposed via SSE (Server-Sent Events) to web clients.

---

## Recommendations

### Priority 1: Critical (Implement First)

#### 1.1 Strengthen Pre-Flight Validation
- ✅ Already checks `globalBudgetState.used >= limit` before execution
- 🔧 Add estimated token requirement check
- 🔧 Reserve budget before parallel batch execution

#### 1.2 Add Detailed Token Breakdown
```typescript
// Enhance SubagentEvent
type SubagentEvent = {
  type: "subagent_end";
  // ... existing fields ...
  tokenBreakdown?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning: number;
  };
  estimatedCost?: {
    total: number;       // USD
    breakdown: { ... };
  };
};
```

#### 1.3 Implement Batch Budget Allocation
```typescript
// Distribute budget across parallel tasks
type SubagentBatchArgs = {
  tasks: SubagentBatchTask[];
  maxConcurrency?: number;
  budgetAllocation?: {
    strategy: "equal" | "priority" | "dynamic";
    perTaskLimit?: number;
  };
};
```

### Priority 2: High Value (Implement Soon)

#### 2.1 Add Cost Tracking
- Integrate with [`src/pi-ai/utils/estimate.ts`](../src/pi-ai/utils/estimate.ts) cost calculation
- Report cost alongside tokens in all events
- Add cost breakdown by model/provider

#### 2.2 Per-Profile Budget Limits
```typescript
export type SubagentProfile = {
  // ... existing fields ...
  tokenBudget?: number;  // Max tokens for this profile
  costBudget?: number;   // Max USD for this profile
};
```

#### 2.3 Budget Warnings
```typescript
// Emit warning events at thresholds
if (globalBudgetState.used > globalBudgetState.limit * 0.8) {
  onSubagentEvent?.({
    type: "budget_warning",
    used: globalBudgetState.used,
    limit: globalBudgetState.limit,
    percentage: 80,
  });
}
```

### Priority 3: Nice to Have (Future Enhancement)

#### 3.1 Token Usage Visualization
- TUI: Bar chart of token usage by subagent
- TUI: Real-time budget meter
- Web UI: Historical token usage graphs

#### 3.2 Analytics & Reporting
```typescript
// Export usage data
exportTokenAnalytics({
  format: "json" | "csv",
  groupBy: "profile" | "model" | "depth",
  includeBreakdown: boolean,
});
```

#### 3.3 Enhanced Test Coverage
- Budget enforcement edge cases
- Parallel batch budget coordination
- Nested hierarchy token accumulation
- Provider-specific usage reporting

---

## Implementation Roadmap

### Phase 1: Foundation (1-2 days)
- [ ] Document current architecture (this document)
- [ ] Add token breakdown to `SubagentEvent` type
- [ ] Integrate cost calculation from pi-ai/utils
- [ ] Enhance existing pre-flight validation

### Phase 2: Budget Management (2-3 days)
- [ ] Implement batch budget allocation
- [ ] Add per-profile budget limits
- [ ] Create budget warning events
- [ ] Add tests for edge cases

### Phase 3: Observability (1-2 days)
- [ ] Enhance CLI token reporting
- [ ] Add TUI token breakdown display
- [ ] Create analytics export functionality
- [ ] Add web UI token visualization

### Phase 4: Polish (1 day)
- [ ] Performance optimization
- [ ] Documentation updates
- [ ] Example usage patterns
- [ ] Migration guide (if breaking changes)

**Total Estimated Effort:** 5-8 days

---

## Test Coverage Gaps

### Current Tests ([`test/subagent.test.ts`](../test/subagent.test.ts))

✅ **Covered:**
- Basic token accumulation
- Zero usage when provider doesn't report
- Token reporting in events

❌ **Missing:**
- Budget exhaustion at exactly limit
- Budget exhaustion mid-execution
- Parallel batch budget coordination
- Nested subagent budget inheritance
- Cost calculation integration
- Token breakdown accuracy
- Provider-specific variations

### Recommended Test Cases

```typescript
describe("token budget enforcement", () => {
  it("prevents execution when budget already exhausted");
  it("stops mid-execution when budget exceeded");
  it("allocates budget fairly across parallel batch");
  it("inherits parent budget state in nested subagents");
  it("reports accurate cost based on model pricing");
  it("handles missing usage info gracefully");
  it("respects per-profile budget limits");
});
```

---

## Conclusion

### Current State: **Functional ✅**

The token tracking system works for basic use cases:
- ✅ Tracks total tokens per subagent
- ✅ Enforces global budget limits
- ✅ Reports usage in events
- ✅ Integrates with CLI/TUI/Server

### Improvement Potential: **High 📈**

Key opportunities:
1. **Cost tracking** - Convert tokens to USD
2. **Token breakdown** - Input/output/cache/reasoning split
3. **Batch coordination** - Budget allocation across parallel tasks
4. **Per-profile limits** - Different budgets for researcher/coder/reviewer
5. **Observability** - Better visualization and analytics

### Risk Level: **Low ⚠️**

Current limitations are not blocking:
- Pre-flight validation already exists
- Budget enforcement is reliable
- Fallback behavior (tokens=0) is safe
- Provider support is good for major LLMs

### Recommendation: **Prioritize Phase 1-2 📋**

Focus on:
1. Token breakdown (foundation for cost tracking)
2. Batch budget allocation (prevents parallel overruns)
3. Enhanced observability (easier debugging)

Defer Phase 3-4 (analytics, visualization) until core functionality is solid.

---

## References

- **Token tracking implementation:** [`src/subagent/tool.ts:640-652`](../src/subagent/tool.ts)
- **Type definitions:** [`src/subagent/types.ts:92-96`](../src/subagent/types.ts)
- **Test coverage:** [`test/subagent.test.ts:1178-1217`](../test/subagent.test.ts)
- **Cost calculation:** [`src/pi-ai/utils/estimate.ts`](../src/pi-ai/utils/estimate.ts)
- **Usage reporting:** [`src/pi-ai/types.ts:367-369`](../src/pi-ai/types.ts)
