# Max Tokens 溢出处理方案

## 问题分析

从截图可以看到错误：
```
✗ LLM output reached max_tokens
  Message, /command, or @file reference
  openrouter/free · .../mini-agent · Bypass permissions · high · Context 32.4k/200k · Failed · Cache 69% (22.3k)
```

**根本原因**：
- 模型 `openrouter/free` 的 `maxTokens` 配置为 **4096**
- 在生成大量代码或长篇响应时，输出超过这个限制
- 系统抛出 `OutputTruncatedError`，TUI 显示 "Failed" 状态

## 解决方案

### 方案 1：提高模型的 maxTokens 限制 ⭐ 推荐

**修改位置**：[src/pi-ai/providers/openrouter.models.ts](/Users/chenjiaxu/Project/agent loop/mini-agent/src/pi-ai/providers/openrouter.models.ts)

```typescript
"openrouter/free": {
    id: "openrouter/free",
    name: "Free Models Router",
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    compat: {"supportsDeveloperRole":false,"thinkingFormat":"openrouter"},
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 16384,  // 从 4096 提升到 16384
}
```

**优点**：
- 简单直接，一次修改解决问题
- 支持更长的输出
- 不影响现有架构

**缺点**：
- 可能增加 API 成本（如果供应商按 token 计费）
- 不适用于所有模型（某些模型有硬性限制）

---

### 方案 2：自动续写（Continuation）机制

**架构改进**：在 TUI 层面捕获 `OutputTruncatedError`，自动续写未完成的响应。

#### 2.1 修改 state.ts - 添加自动续写状态

```typescript
// src/tui/state.ts

export type TuiAction =
  | ...
  | { type: "auto_continue_truncated" }  // 新增

case "error": {
  // 检测是否是 max_tokens 错误
  const isTruncated = event.error?.name === "OutputTruncatedError" ||
                      /max_tokens/i.test(event.message);
  
  if (isTruncated && state.busy) {
    // 自动触发续写
    return {
      ...state,
      status: "Output truncated, auto-continuing…",
      // 保持 busy 状态，不标记为 failed
    };
  }
  
  // 原有错误处理逻辑
  const newMessages: ChatMessage[] = [...state.messages, { kind: "error", text: event.message }];
  return {
    ...state,
    busy: false,
    messages: newMessages,
    status: "Request failed",
    taskStatus: "failed",
    // ...
  };
}
```

#### 2.2 修改 App.tsx - 添加续写逻辑

```typescript
// src/tui/App.tsx

useEffect(() => {
  if (!state.busy) return;
  
  const handleStreamEvent = async (event: LoopEvent) => {
    if (event.type === "error") {
      const isTruncated = event.error?.name === "OutputTruncatedError" ||
                          /max_tokens/i.test(event.message);
      
      if (isTruncated) {
        // 自动续写
        dispatch({ type: "auto_continue_truncated" });
        
        // 延迟 500ms 后继续
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // 触发续写（不添加新的 user 消息）
        const continuePrompt = tuiContinuationPrompt(state.messages);
        await runTuiAgentTurn(state.messages, continuePrompt, {
          llmConfig: state.llmConfig,
          systemPrompt: state.systemPrompt,
          // ...
        });
        return;
      }
    }
    
    dispatch(event);
  };
  
  // ...
}, [state.busy]);
```

**优点**：
- 用户无需手动干预
- 支持任意长度的输出
- 保持上下文连贯性

**缺点**：
- 增加架构复杂度
- 可能产生更多 API 调用
- 需要处理续写循环的边界条件

---

### 方案 3：分块策略（Chunking Strategy）

**适用场景**：当输出是结构化内容（如代码、文档、数据）时。

#### 实现思路

1. **在 System Prompt 中添加指导**：
```typescript
// src/loop.ts

const systemPrompt = `
${originalSystemPrompt}

**Output Length Management**:
When generating large responses (code, documents, lists):
- If approaching token limits, use multiple tool calls instead of single large responses
- Split large code changes into multiple edit calls
- Use file operations for content that exceeds 2000 tokens
- Prefer structured data over prose when possible
`;
```

2. **工具层面的支持**：
```typescript
// 在 tools.ts 中添加分块写入工具
{
  name: "append_to_file",
  description: "Append content to a file (useful for large outputs)",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
  },
}
```

**优点**：
- 模型更智能地管理输出
- 自然地分解复杂任务
- 减少单次请求压力

**缺点**：
- 依赖 LLM 的理解能力
- 可能增加工具调用次数
- 需要训练用户提示词习惯

---

### 方案 4：动态 maxTokens 调整

**根据任务类型动态设置 maxTokens**：

```typescript
// src/llm/index.ts

export function estimateRequiredTokens(prompt: string, context: AgentMessage[]): number {
  const hasCodeRequest = /write|implement|create.*file|refactor/i.test(prompt);
  const hasLongOutput = /explain|document|analyze|review/i.test(prompt);
  
  if (hasCodeRequest) return 16384;
  if (hasLongOutput) return 8192;
  return 4096; // 默认
}

// 在 runAgentTurn 中使用
const maxTokens = Math.max(
  config.maxTokens,
  estimateRequiredTokens(prompt, history)
);
```

**优点**：
- 按需分配资源
- 提升用户体验
- 减少不必要的成本

**缺点**：
- 启发式规则可能不准确
- 增加判断逻辑复杂度

---

## 推荐实施路径

### 短期（立即修复）
1. **提升 openrouter/free 的 maxTokens 到 16384**
2. **在 TUI 中添加友好的错误提示和手动 /continue 建议**

```typescript
// src/tui/state.ts
case "error": {
  const isTruncated = /max_tokens/i.test(event.message);
  const errorText = isTruncated
    ? `${event.message}\n\n💡 Tip: Use /continue to resume the response, or switch to a model with higher token limits.`
    : event.message;
  
  const newMessages: ChatMessage[] = [...state.messages, { kind: "error", text: errorText }];
  // ...
}
```

### 中期（1-2 周）
3. **实现方案 2 的自动续写机制**
4. **添加环境变量配置**：
```bash
# .env
MINI_AGENT_AUTO_CONTINUE_ON_TRUNCATE=true
MINI_AGENT_MAX_AUTO_CONTINUES=3
```

### 长期（1 个月）
5. **实现方案 4 的动态 maxTokens 调整**
6. **在模型配置中添加 recommendedMaxTokens 字段**
7. **建立 token 预算管理系统**

---

## 验证测试

### 测试用例
```typescript
// test/max-tokens-handling.test.ts

describe("Max tokens handling", () => {
  it("should auto-continue when output is truncated", async () => {
    // 模拟超长输出
    const prompt = "Generate a 10,000 line TypeScript file";
    const result = await runTuiAgentTurn([], prompt, {
      llmConfig: { maxTokens: 1000 }, // 故意设置很小
    });
    
    // 验证自动续写
    expect(result.stop).toBeUndefined();
    expect(result.history.length).toBeGreaterThan(2); // 至少有 2 次续写
  });
  
  it("should show helpful error when auto-continue is disabled", async () => {
    process.env.MINI_AGENT_AUTO_CONTINUE_ON_TRUNCATE = "false";
    // ...
    expect(errorMessage).toContain("Use /continue");
  });
});
```

---

## 总结

| 方案 | 复杂度 | 效果 | 优先级 |
|------|--------|------|--------|
| 1. 提高 maxTokens | 低 | 立即见效 | ⭐⭐⭐⭐⭐ |
| 2. 自动续写 | 中 | 完美体验 | ⭐⭐⭐⭐ |
| 3. 分块策略 | 低 | 长期优化 | ⭐⭐⭐ |
| 4. 动态调整 | 中 | 智能优化 | ⭐⭐⭐ |

**建议**：先实施方案 1 解决燃眉之急，然后逐步实施方案 2 和 4 提升用户体验。
