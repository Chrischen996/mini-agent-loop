# Prompt Cache Design V2 - Revised Proposal

## Executive Summary

基于 `reset-cache-design.md` 的代码审查反馈，本方案修正了与现有代码的冲突点，采用**渐进式扩展**而非**新建独立模块**的策略。

---

## 问题回顾与修正

### 原方案问题

| # | 问题 | 修正方案 |
|---|------|----------|
| 1 | 三层架构过度设计 | 简化为两层：数据层 + 展示层 |
| 2 | `CacheMetrics.requestId` 用 UUID | 改为复用前缀 fingerprint 作为关联键 |
| 3 | 新建 `CacheMetrics` 类型不兼容 | 扩展现有 `StreamChatUsage` |
| 4 | `cacheWriteTokens` 计算逻辑错误 | 直接使用 provider 返回字段 |
| 5 | StatusBar 使用 emoji | 改用纯文本 `CACHE:82%` |
| 6 | 硬编码定价映射 | 移除货币估算，只展示 token 数据 |
| 7 | invalidation 分析太简单 | 分别追踪 system/tools 变更 |
| 8 | `/cache` 命令实现路径不明确 | 通过现有 `ADD_NOTICE` action 实现 |

---

## 修正后的架构

```
┌─────────────────────────────────────────────────────┐
│  展示层 (TUI/CLI)                                    │
│  - StatusBar: CACHE:82%                              │
│  - /cache status: 详细统计                            │
└─────────────────────────────────────────────────────┘
                          ↑
┌─────────────────────────────────────────────────────┐
│  数据层 (扩展现有类型)                                 │
│  - StreamChatUsage 加 cacheRead/cacheWrite           │
│  - pi-ai Usage 已支持此字段                          │
│  - wire.ts fromPiAssistant 转换                       │
└─────────────────────────────────────────────────────┘
```

---

## 实施步骤

### Step 1: 扩展 `StreamChatUsage` 类型

**文件**: `src/llm/retry.ts`

```typescript
export type StreamChatUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  // 新增字段
  cacheReadTokens?: number;    // 缓存命中 tokens
  cacheWriteTokens?: number;   // 缓存写入 tokens
};
```

**影响范围**:
- `src/llm/retry.ts:8` - 类型定义
- `src/llm/chat.ts:362` - usage 变量声明
- `src/loop.ts:149` - LoopEvent assistant 类型
- `src/tui/state.ts:379` - contextTokens 消费

**兼容性**: 可选字段，向后兼容

---

### Step 2: 在 `chat.ts` 提取 cache 字段

**文件**: `src/llm/chat.ts`

当前 `streamChat` 已有 usage 解析逻辑，只需提取 cache 字段：

```typescript
// 现有代码已有 usage 解析
if (parsed.usage) {
  usage = {
    promptTokens: parsed.usage.prompt_tokens ?? 0,
    completionTokens: parsed.usage.completion_tokens ?? 0,
    totalTokens: parsed.usage.total_tokens ?? 0,
    // 新增: cache 字段
    cacheReadTokens: parsed.usage.prompt_tokens_details?.cached_tokens 
                  ?? parsed.usage.prompt_cache_hit_tokens 
                  ?? 0,
    cacheWriteTokens: parsed.usage.prompt_tokens_details?.cache_write_tokens 
                    ?? 0,
  };
}
```

**注意**: pi-ai 适配器 (`streamPiChat`) 已通过 `fromPiAssistant` 转换，无需修改。

---

### Step 3: TUI StatusBar 显示缓存状态

**文件**: `src/tui/components/StatusBar.tsx`

```typescript
type StatusBarProps = {
  // ... existing props
  cacheHitRate?: number;      // 新增: 命中率 0-1
  cacheSavedTokens?: number;  // 新增: 节省的 tokens
};

export function StatusBar({ 
  cacheHitRate, 
  cacheSavedTokens,
  // ... other props
}: StatusBarProps) {
  const cacheIndicator = cacheHitRate !== undefined 
    ? `CACHE:${Math.round(cacheHitRate * 100)}%` 
    : '';
  
  const savedText = cacheSavedTokens 
    ? `[-${cacheSavedTokens}tok]` 
    : '';

  return (
    <Box gap={2} flexShrink={1}>
      {/* ... existing ... */}
      {(cacheIndicator || savedText) && (
        <Text color={C.info} wrap="truncate-end">
          {cacheIndicator} {savedText}
        </Text>
      )}
    </Box>
  );
}
```

**文件**: `src/tui/App.tsx`

在事件处理中传递缓存指标：

```typescript
// 从 assistant event 提取 usage
case 'assistant':
  const hitRate = event.usage?.cacheReadTokens 
    ? event.usage.cacheReadTokens / event.usage.totalTokens 
    : undefined;
  setLastCacheMetrics({
    hitRate,
    savedTokens: event.usage?.cacheReadTokens ?? 0,
  });
  break;
```

---

### Step 4: 前缀 Fingerprint 追踪

**文件**: `src/llm/cache-fingerprint.ts`

```typescript
import { createHash } from 'node:crypto';
import type { Tool } from '../tools/types.ts';

/** 计算 prompt 前缀指纹用于检测变更 */
export function computePrefixFingerprint(
  systemPrompt: string,
  tools: Tool[] | undefined,
): string {
  // 分离追踪 system 和 tools
  const systemHash = createHash('sha256')
    .update(systemPrompt)
    .digest('hex')
    .slice(0, 8);
  
  const toolsJson = tools?.length 
    ? JSON.stringify(tools.map(t => ({ 
        name: t.name, 
        parameters: t.parameters 
      })))
    : '[]';
  const toolsHash = createHash('sha256')
    .update(toolsJson)
    .digest('hex')
    .slice(0, 8);
  
  return `${systemHash}:${toolsHash}`;
}

/** 分析缓存失效原因 */
export function analyzeInvalidation(
  previous: string | null,
  current: string,
): { changed: boolean; reason?: string } {
  if (!previous) return { changed: false };
  
  const [prevSystem, prevTools] = previous.split(':');
  const [currSystem, currTools] = current.split(':');
  
  if (prevSystem !== currSystem && prevTools !== currTools) {
    return { changed: true, reason: 'system_and_tools_changed' };
  }
  if (prevSystem !== currSystem) {
    return { changed: true, reason: 'system_prompt_changed' };
  }
  if (prevTools !== currTools) {
    return { changed: true, reason: 'tools_changed' };
  }
  return { changed: false };
}
```

---

### Step 5: `/cache` 命令实现

**文件**: `src/tui/state.ts`

新增 action:

```typescript
export type TuiAction =
  // ... existing actions
  | { type: "CACHE_UPDATE"; hitRate: number; savedTokens: number }
  | { type: "ADD_NOTICE"; title?: string; text: string };
```

**文件**: `src/tui/App.tsx` - 命令处理

```typescript
if (trimmed === '/cache status' || trimmed === '/cache') {
  const stats = cacheTracker.getStats();
  dispatch({
    type: "ADD_NOTICE",
    title: "Cache Statistics",
    text: formatCacheStats(stats),
  });
  setInput("");
  return;
}

if (trimmed === '/cache on') {
  // 启用缓存
  dispatch({ type: "SET_CACHE_ENABLED", enabled: true });
  setInput("");
  return;
}

if (trimmed === '/cache off') {
  // 禁用缓存
  dispatch({ type: "SET_CACHE_ENABLED", enabled: false });
  setInput("");
  return;
}
```

**输出格式**:

```
╔══════════════════════════════════════════╗
║  Cache Statistics                         ║
╠══════════════════════════════════════════╣
║  Hit Rate: 78% (4,680 / 6,000 tokens)    ║
║  Prefix: a3f8c2d1:e5f9b4c7               ║
║  Last Change: tools_changed              ║
║  Sessions Cached: 3                      ║
╚══════════════════════════════════════════╝
```

---

### Step 6: 测试

**文件**: `test/cache-fingerprint.test.ts`

```typescript
import { describe, it, assert } from 'node:test';
import { 
  computePrefixFingerprint, 
  analyzeInvalidation 
} from '../src/llm/cache-fingerprint.ts';

describe('cache fingerprint', () => {
  it('computes consistent prefix fingerprint', () => {
    const fp1 = computePrefixFingerprint('system prompt', []);
    const fp2 = computePrefixFingerprint('system prompt', []);
    assert.equal(fp1, fp2);
  });

  it('detects system prompt change', () => {
    const fp1 = computePrefixFingerprint('system v1', []);
    const fp2 = computePrefixFingerprint('system v2', []);
    const analysis = analyzeInvalidation(fp1, fp2);
    assert.ok(analysis.changed);
    assert.equal(analysis.reason, 'system_prompt_changed');
  });

  it('detects tool change', () => {
    const tools1 = [{ name: 'read', parameters: {} }];
    const tools2 = [{ name: 'read', parameters: {} }, { name: 'write', parameters: {} }];
    const fp1 = computePrefixFingerprint('system', tools1);
    const fp2 = computePrefixFingerprint('system', tools2);
    const analysis = analyzeInvalidation(fp1, fp2);
    assert.ok(analysis.changed);
    assert.equal(analysis.reason, 'tools_changed');
  });
});
```

---

## 优先级调整

| Phase | 内容 | 复杂度 | 价值 |
|-------|------|--------|------|
| **P0** | 扩展 `StreamChatUsage` + 提取 cache 字段 | 低 | 拿到真实数据 |
| **P1** | StatusBar 显示 `CACHE:82%` | 低 | 用户可见 |
| **P2** | Fingerprint + Invalidation 分析 | 中 | 可观测性 |
| **P3** | `/cache` 命令 | 低 | 交互能力 |

---

## 预期效果

### 状态栏实时显示

```
[MODEL: gpt-4o] [THINK: high] [CACHE:82%] [-4.6k tok] [AUTO]
```

### `/cache status` 输出

```
╔══════════════════════════════════════════╗
║  Cache Statistics                         ║
╠══════════════════════════════════════════╣
║  Hit Rate: 78% (4,680 / 6,000 tokens)    ║
║  Prefix Fingerprint:                      ║
║    System: a3f8c2d1                       ║
║    Tools:  e5f9b4c7                       ║
║  Last Invalidation: tools_changed         ║
║  Sessions with Cache: 3                   ║
║                                           ║
║  Tips:                                    ║
║  ✓ System prompt length > 64 tokens       ║
║  ⚠ Tool definitions changed last turn     ║
╚══════════════════════════════════════════╝
```

---

## 与 DeepSeek Harness 对比

| 特性 | Harness | mini-agent V2 |
|------|---------|---------------|
| 缓存策略 | Prefix Cache (自动) | Prompt Cache Key + Prefix 检测 |
| 命中计量 | ✅ 原生 | ✅ 扩展 usage |
| 失效检测 | 隐式 | 显式 fingerprint |
| 跨 Provider | DeepSeek only | OpenAI/Anthropic/DeepSeek |
| 可视化 | 日志 | TUI 实时显示 |
| 命令控制 | 无 | `/cache on/off/status` |

---

## 下一步

1. 修改 `src/llm/retry.ts` 扩展 `StreamChatUsage`
2. 修改 `src/llm/chat.ts` 提取 cache 字段
3. 修改 `src/tui/components/StatusBar.tsx` 添加显示
4. 编写测试验证
5. 集成 `/cache` 命令
