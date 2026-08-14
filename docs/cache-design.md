# Prompt Cache Design Proposal

## Overview

This document proposes importing and adapting DeepSeek Harness's prefix caching mechanism into mini-agent, combined with mini-agent's existing cross-provider cache key support.

## Current State Analysis

### Mini-agent Implementation

- **Strategy**: Prompt Cache Key (explicit client-side control)
- **Retention**: Configurable via `PI_CACHE_RETENTION=long` (24h/1h)
- **Providers**: OpenAI, Anthropic, Mistral, OpenRouter
- **Metrics**: Parses `cached_tokens` from usage, but no visualization

### DeepSeek Harness Implementation

- **Strategy**: Prefix Cache (server-side automatic)
- **Mechanism**: Unchanged prompt prefix is automatically cached by provider
- **Precision**: Native `prompt_cache_hit_tokens` field parsing
- **Testing**: E2E tests verify real API cache hits

## Design: Three-Layer Architecture

```
┌─────────────────────────────────────────────────────┐
│  Layer 3: Visualization (TUI/Server)                 │
│  - Status Bar: hit rate / savings / cache status     │
│  - /cache command: detailed stats and config         │
└─────────────────────────────────────────────────────┘
                          ↑
┌─────────────────────────────────────────────────────┐
│  Layer 2: Detection (CacheTracker)                   │
│  - Prefix fingerprint: system_prompt + tool_schemas  │
│  - Change detection: which parts caused invalidation │
│  - Hit rate calculation: cacheRead / total           │
└─────────────────────────────────────────────────────┘
                          ↑
┌─────────────────────────────────────────────────────┐
│  Layer 1: Protocol (llm/chat.ts)                     │
│  - Enhanced usage parsing: extract cache metrics     │
│  - Event extension: cache_hit / cache_miss           │
│  - Provider compatibility: OpenAI/Anthropic/DeepSeek │
└─────────────────────────────────────────────────────┘
```

## Implementation Plan

### Step 1: New `src/llm/cache-tracker.ts`

```typescript
/**
 * Cache tracker: detects prefix stability, calculates hit rate, provides optimization suggestions
 */
import { createHash } from 'node:crypto';
import type { AssistantMessage } from '../types.ts';
import type { Tool } from '../tools/types.ts';

export type CacheStatus = 'miss' | 'partial' | 'hit';

export type CacheMetrics = {
  /** Request ID (for correlation) */
  requestId: string;
  /** Total prompt tokens */
  totalPromptTokens: number;
  /** Cache hit tokens */
  cacheReadTokens: number;
  /** Cache write tokens (first request or after change) */
  cacheWriteTokens: number;
  /** Non-cache input tokens */
  inputTokens: number;
  /** Hit rate (0-1) */
  hitRate: number;
  /** Cache status */
  status: CacheStatus;
  /** Estimated savings (USD) */
  estimatedSavings: number;
  /** Provider pricing ($/M tokens) */
  pricing?: {
    full: number;
    cacheRead: number;
  };
  /** Invalidation reason (if any) */
  invalidationReason?: string;
};

/** Prefix fingerprint: system_prompt + tool_schemas */
export function computePrefixFingerprint(
  systemPrompt: string,
  tools: Tool[] | undefined,
): string {
  const toolsJson = tools?.length 
    ? JSON.stringify(tools.map(t => ({ name: t.name, parameters: t.parameters })))
    : '[]';
  const data = `${systemPrompt}\x00${toolsJson}`;
  return createHash('sha256').update(data).digest('hex').slice(0, 12);
}

/** Parse cache metrics from usage */
export function parseCacheMetrics(
  usage: AssistantMessage['usage'],
  provider: string,
): CacheMetrics | null {
  if (!usage || usage.totalTokens === 0) return null;

  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  const input = usage.input ?? 0;
  const totalPrompt = input + cacheRead + cacheWrite;

  if (totalPrompt === 0) return null;

  const hitRate = cacheRead / totalPrompt;
  const status: CacheStatus = 
    cacheRead === 0 ? 'miss' 
    : hitRate > 0.8 ? 'hit' 
    : 'partial';

  // Provider pricing (simplified, actual should read from model config)
  const pricingMap: Record<string, { full: number; cacheRead: number }> = {
    'openai': { full: 2.5, cacheRead: 0.25 },      // GPT-4o
    'anthropic': { full: 3.0, cacheRead: 0.25 },   // Claude
    'deepseek': { full: 0.14, cacheRead: 0.014 },  // DeepSeek V4
    'openrouter': { full: 1.0, cacheRead: 0.1 },
  };
  const pricing = pricingMap[provider] ?? { full: 1.0, cacheRead: 0.1 };
  
  const savings = cacheRead / 1_000_000 * (pricing.full - pricing.cacheRead);

  return {
    requestId: crypto.randomUUID(),
    totalPromptTokens: totalPrompt,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    inputTokens: input,
    hitRate,
    status,
    estimatedSavings: Math.round(savings * 100) / 100,
    pricing,
  };
}

/** Analyze cache invalidation reason */
export function analyzeInvalidation(
  previousFingerprint: string | null,
  currentFingerprint: string,
  systemPrompt: string,
  tools: Tool[] | undefined,
): string | null {
  if (!previousFingerprint) return null; // First request, no invalidation
  
  if (previousFingerprint !== currentFingerprint) {
    return 'prefix_changed';
  }
  return null;
}
```

### Step 2: Modify `src/llm/chat.ts` to Enhance Usage Parsing

```typescript
// Add cache tracking in streamChat
export async function* streamChat(
  config: LlmConfig,
  messages: AgentMessage[],
  tools?: Tool[],
  signal?: AbortSignal,
): AsyncGenerator<LlmStreamEvent> {
  // ... existing code ...

  let lastCacheMetrics: CacheMetrics | null = null;
  const prefixFingerprint = computePrefixFingerprint(
    messages.find(m => m.role === 'system')?.content ?? '',
    tools,
  );

  for await (const event of innerStream) {
    if (event.type === 'completed' && event.usage) {
      const metrics = parseCacheMetrics(event.usage, config.provider);
      if (metrics) {
        metrics.requestId = prefixFingerprint;
        metrics.invalidationReason = analyzeInvalidation(
          lastCacheMetrics?.requestId ?? null,
          prefixFingerprint,
          messages.find(m => m.role === 'system')?.content ?? '',
          tools,
        );
        lastCacheMetrics = metrics;
        
        // Emit cache event before completed
        yield { type: 'cache_update', metrics };
      }
    }
    yield event;
  }
}
```

### Step 3: Extend `LlmStreamEvent` Type

```typescript
// src/llm/retry.ts
export type LlmStreamEvent =
  | { type: "reasoning_delta"; text: string }
  | { type: "answer_delta"; text: string }
  | { type: "tool_call_delta"; delta: ToolCallDelta }
  | { type: "completed"; message: AssistantMessage; usage?: StreamChatUsage }
  | { type: "cache_update"; metrics: CacheMetrics }  // New
  | { type: "error"; error: Error }
  | { type: "attempt_reset" };
```

### Step 4: TUI Status Bar Cache Indicator

```tsx
// src/tui/components/StatusBar.tsx
type StatusBarProps = {
  // ... existing props
  cacheStatus?: CacheStatus;
  cacheHitRate?: number;
  cacheSavings?: number;
};

export function StatusBar({ 
  cacheStatus, 
  cacheHitRate, 
  cacheSavings 
}: StatusBarProps) {
  // Cache indicator
  const cacheIndicator = cacheStatus === 'hit' 
    ? `💾 ${Math.round(cacheHitRate * 100)}%` 
    : cacheStatus === 'partial'
      ? `💾 ${Math.round(cacheHitRate * 100)}%`
      : cacheStatus === 'miss'
        ? '📝'
        : '';
  
  const savingsText = cacheSavings > 0 
    ? `省 $${cacheSavings.toFixed(2)}` 
    : '';

  return (
    <Box gap={2} flexShrink={1}>
      {/* ... existing ... */}
      {cacheIndicator && (
        <Text color={C.info} wrap="truncate-end">
          {cacheIndicator} {savingsText}
        </Text>
      )}
    </Box>
  );
}
```

### Step 5: New `/cache` Command

```typescript
// src/cli.ts or TUI command handler
const CACHE_COMMANDS = {
  '/cache status': 'Show current session cache stats',
  '/cache on': 'Enable prompt caching',
  '/cache off': 'Disable prompt caching',
  '/cache long': 'Enable 24h retention',
} as const;

// Handler logic
case '/cache status':
  const stats = cacheTracker.getStats();
  dispatch({
    type: 'ADD_NOTICE',
    title: 'Cache Stats',
    text: formatCacheStats(stats),
  });
  break;
```

### Step 6: New Tests

```typescript
// test/cache-tracker.test.ts
import { describe, it, assert } from 'node:test';
import { 
  computePrefixFingerprint, 
  parseCacheMetrics,
  analyzeInvalidation 
} from '../src/llm/cache-tracker.ts';

describe('cache tracker', () => {
  it('computes consistent prefix fingerprint', () => {
    const fp1 = computePrefixFingerprint('system prompt', []);
    const fp2 = computePrefixFingerprint('system prompt', []);
    assert.equal(fp1, fp2); // Same input produces same fingerprint
  });

  it('detects fingerprint change on tool addition', () => {
    const fp1 = computePrefixFingerprint('system', [
      { name: 'read', parameters: {} }
    ]);
    const fp2 = computePrefixFingerprint('system', [
      { name: 'read', parameters: {} },
      { name: 'write', parameters: {} }
    ]);
    assert.notEqual(fp1, fp2);
  });

  it('parses cache metrics from usage', () => {
    const metrics = parseCacheMetrics({
      input: 100,
      output: 50,
      cacheRead: 800,
      cacheWrite: 0,
      totalTokens: 950,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    }, 'openai');
    
    assert.ok(metrics);
    assert.equal(metrics.hitRate, 0.8); // 800/(100+800)
    assert.equal(metrics.status, 'hit');
  });
});
```

## Expected Output

### `/cache status` Command Output

```
╔══════════════════════════════════════════╗
║  Cache Statistics                         ║
╠══════════════════════════════════════════╣
║  Hit Rate: 78% (4,680 / 6,000 tokens)    ║
║  Savings: $0.42 / session                ║
║  Status: 💾 Good                         ║
║                                          ║
║  Prefix Fingerprint: a3f8c2d1e5f9        ║
║  Last Invalidation: None                 ║
║                                          ║
║  Suggestions:                            ║
║  ✓ System prompt length sufficient       ║
║  ✓ Tool definitions unchanged            ║
╚══════════════════════════════════════════╝
```

### Status Bar Real-time Display

```
[Cached 82%] [-$0.18] Thinking: high
```

## Implementation Priority

| Phase | Content | Complexity | Benefit |
|-------|---------|------------|---------|
| **P0** | Usage parsing enhancement + CacheMetrics type | Low | Basic data collection |
| **P1** | Prefix fingerprint + invalidation analysis | Medium | Observability |
| **P2** | TUI status bar cache indicator | Medium | User experience |
| **P3** | `/cache` command + detailed stats | Low | Interaction capability |
| **P4** | Optimization suggestions (system prompt length check) | High | Performance improvement |

## Comparison with DeepSeek Harness

| Feature | Harness | Mini-agent Proposed |
|---------|---------|---------------------|
| Cache Strategy | Prefix Cache (server auto) | Mixed: prefix + explicit key |
| Prefix Awareness | ✅ request/header events | Explicit fingerprint tracking |
| Hit Metrics | ✅ Native field parsing | ✅ Enhanced parsing |
| Invalidation Warning | ✅ Frontend display | ✅ Fingerprint comparison |
| Optimization Tips | ✅ Documentation | ✅ AI-generated suggestions |
| Cross-Provider | DeepSeek only | OpenAI/Anthropic/DeepSeek |
| Retention Control | Server auto | Client configurable |

## Key Value Proposition

**Transform black-box caching into observable, optimizable white-box behavior.**

The core insight from Harness is that prefix stability determines cache efficiency. By adding fingerprint tracking and hit rate visualization, mini-agent users can:

1. See real-time cache performance
2. Understand why caches miss
3. Optimize system prompts and tool definitions
4. Estimate cost savings

## Next Steps

1. Create `src/llm/cache-tracker.ts`
2. Extend `LlmStreamEvent` type in `src/llm/retry.ts`
3. Modify `src/llm/chat.ts` to emit cache events
4. Update TUI status bar components
5. Add `/cache` command handler
6. Write tests in `test/cache-tracker.test.ts`
