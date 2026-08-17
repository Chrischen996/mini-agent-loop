# Plan-Act 下一步开发指南

## 📊 当前进度

### ✅ 已完成：Phase 1 - 核心数据结构与状态机

**完成情况：100%**

- ✅ 核心类型定义（[`src/plan-act/types.ts`](src/plan-act/types.ts)）
- ✅ 状态机实现（[`src/plan-act/state-machine.ts`](src/plan-act/state-machine.ts)）
- ✅ 计划管理器（[`src/plan-act/plan-manager.ts`](src/plan-act/plan-manager.ts)）
- ✅ 计划生成器（[`src/plan-act/plan-generator.ts`](src/plan-act/plan-generator.ts)）
- ✅ 计划执行器（[`src/plan-act/plan-executor.ts`](src/plan-act/plan-executor.ts)）
- ✅ Session 扩展（[`src/server.ts`](src/server.ts), [`src/session-store.ts`](src/session-store.ts)）
- ✅ 单元测试（30个测试全部通过）

---

## 🎯 下一步：Phase 2 & 3 - API 端点与集成

### Phase 2: REST API 端点实现（2-3天）

#### 优先级 1：核心 API 端点

**文件：[`src/server.ts`](src/server.ts)**

```typescript
// 1. 生成计划（自动进入 Planning → Review）
app.post("/api/sessions/:id/plan", async (request, response) => {
  const session = sessions.get(request.params.id);
  if (!session) {
    response.status(404).json({ error: "Session not found" });
    return;
  }
  
  // 切换到 planning 阶段
  session.phase = "planning";
  
  // 触发计划生成（通过 Loop）
  // ... 实现逻辑
  
  response.json({ phase: session.phase });
});

// 2. 获取当前计划
app.get("/api/sessions/:id/plan", async (request, response) => {
  const session = sessions.get(request.params.id);
  if (!session) {
    response.status(404).json({ error: "Session not found" });
    return;
  }
  
  response.json({
    phase: session.phase,
    currentPlan: session.currentPlan ?? null,
  });
});

// 3. 批准计划
app.post("/api/sessions/:id/plan/approve", async (request, response) => {
  const session = sessions.get(request.params.id);
  if (!session) {
    response.status(404).json({ error: "Session not found" });
    return;
  }
  
  if (session.phase !== "review") {
    response.status(400).json({ 
      error: "Can only approve plan in review phase",
      currentPhase: session.phase 
    });
    return;
  }
  
  const plan = session.currentPlan;
  if (!plan) {
    response.status(404).json({ error: "No plan to approve" });
    return;
  }
  
  // 状态转换验证
  const transition = validatePhaseTransition(session.phase, "acting");
  if (!transition.allowed) {
    response.status(400).json({ error: transition.reason });
    return;
  }
  
  // 批准计划
  plan.status = "approved";
  plan.reviewedAt = Date.now();
  session.phase = "acting";
  
  await saveSession(session);
  
  response.json({ 
    phase: session.phase,
    plan: plan 
  });
});

// 4. 拒绝计划
app.post("/api/sessions/:id/plan/reject", async (request, response) => {
  const session = sessions.get(request.params.id);
  if (!session) {
    response.status(404).json({ error: "Session not found" });
    return;
  }
  
  if (session.phase !== "review") {
    response.status(400).json({ 
      error: "Can only reject plan in review phase",
      currentPhase: session.phase 
    });
    return;
  }
  
  const plan = session.currentPlan;
  if (plan) {
    plan.status = "rejected";
    plan.reviewedAt = Date.now();
    plan.reviewNotes = request.body?.reason;
  }
  
  session.phase = "cancelled";
  await saveSession(session);
  
  response.json({ phase: session.phase });
});

// 5. 要求修改计划
app.post("/api/sessions/:id/plan/modify", async (request, response) => {
  const session = sessions.get(request.params.id);
  if (!session) {
    response.status(404).json({ error: "Session not found" });
    return;
  }
  
  if (session.phase !== "review") {
    response.status(400).json({ 
      error: "Can only modify plan in review phase" 
    });
    return;
  }
  
  const plan = session.currentPlan;
  if (plan) {
    plan.status = "modified";
    plan.reviewNotes = request.body?.feedback;
  }
  
  session.phase = "planning";
  await saveSession(session);
  
  response.json({ 
    phase: session.phase,
    feedback: request.body?.feedback 
  });
});
```

#### 优先级 2：执行控制 API

```typescript
// 6. 执行计划（进入 Acting 阶段）
app.post("/api/sessions/:id/execute", async (request, response) => {
  const session = sessions.get(request.params.id);
  if (!session || session.phase !== "acting") {
    response.status(400).json({ error: "Session not in acting phase" });
    return;
  }
  
  const plan = session.currentPlan;
  if (!plan || plan.status !== "approved") {
    response.status(400).json({ error: "No approved plan to execute" });
    return;
  }
  
  // 创建执行器
  const executor = new PlanExecutor(
    session.tools,
    session.permissionManager,
    {
      onStepStart: (step) => {
        // 发送 SSE 事件
        send({ type: "step_started", step });
      },
      onStepComplete: (step, result) => {
        send({ type: "step_completed", step, result });
      },
      onStepFailed: (step, error) => {
        send({ type: "step_failed", step, error });
      },
    }
  );
  
  try {
    await executor.execute(plan, abortController.signal);
    session.phase = "completed";
    await saveSession(session);
    response.json({ phase: session.phase, success: true });
  } catch (error) {
    response.status(500).json({ 
      error: error.message,
      phase: session.phase 
    });
  }
});

// 7. 取消执行
app.post("/api/sessions/:id/cancel", async (request, response) => {
  const session = sessions.get(request.params.id);
  if (!session) {
    response.status(404).json({ error: "Session not found" });
    return;
  }
  
  session.phase = "cancelled";
  await saveSession(session);
  
  response.json({ phase: session.phase });
});
```

#### 实施检查清单

**第一步：添加 API 路由（1天）**

- [ ] 在 [`src/server.ts`](src/server.ts) 中添加 7 个新端点
- [ ] 导入 plan-act 模块：`import { validatePhaseTransition, PlanExecutor } from "./plan-act/index.ts"`
- [ ] 添加错误处理和状态验证
- [ ] 更新 `/api/sessions/:id` 返回值，包含 `phase` 和 `currentPlan`

**第二步：事件系统集成（1天）**

- [ ] 在 Server 的 SSE 流中添加 plan-act 事件类型
- [ ] 定义事件格式：`plan_generated`, `step_started`, `step_completed`, `step_failed`
- [ ] 更新 [`safeEvent()`](src/server.ts) 函数支持新事件

**第三步：测试（0.5天）**

- [ ] 创建 `test/server-plan-act.test.ts`
- [ ] 测试每个 API 端点的正常流程
- [ ] 测试错误情况（错误阶段、缺失计划等）

---

### Phase 3: Loop 集成（2-3天）

#### 核心修改：[`src/loop.ts`](src/loop.ts)

**关键集成点 1：检测 Session 阶段**

```typescript
// 在 runAgentTurn 函数开头添加
export async function runAgentTurn(
  history: AgentMessage[],
  userText: string,
  options: TurnOptions & { session?: Session }  // 新增 session 参数
): Promise<AgentMessage[]> {
  const { session, ...restOptions } = options;
  
  // 阶段感知逻辑
  if (session) {
    if (session.phase === "planning") {
      // Planning 阶段：强制 plan 模式
      restOptions.permissionMode = "plan";
      restOptions.tools = filterReadOnlyTools(restOptions.tools);
      
      // 包装 onEvent，检测计划生成
      const originalOnEvent = restOptions.onEvent;
      restOptions.onEvent = (event) => {
        originalOnEvent?.(event);
        
        if (event.type === "assistant" && event.content) {
          // 尝试解析计划
          const generator = new PlanGenerator();
          try {
            const plan = generator.parseFromLlmOutput(event.content);
            if (plan) {
              // 保存计划并切换阶段
              session.currentPlan = plan;
              session.phase = "review";
              
              // 触发计划生成事件
              originalOnEvent?.({ 
                type: "plan_generated", 
                plan 
              });
            }
          } catch {
            // 继续等待更完整的输出
          }
        }
      };
    }
    
    if (session.phase === "acting") {
      // Acting 阶段：使用计划的执行模式
      const plan = session.currentPlan;
      if (plan) {
        restOptions.permissionMode = plan.executionMode ?? "auto";
        
        // 重要：拦截工具执行，确保只执行计划中的步骤
        const originalExecuteTool = restOptions.executeTool;
        restOptions.executeTool = async (tool, args, signal) => {
          // 检查工具是否在计划中
          const step = plan.steps.find(s => s.tool === tool.name);
          if (!step) {
            throw new Error(
              `Tool ${tool.name} not in approved plan. ` +
              `Approved tools: ${plan.requiredTools.join(", ")}`
            );
          }
          
          // 使用 PlanExecutor 执行
          const executor = new PlanExecutor(
            [tool],
            session.permissionManager,
            {}
          );
          return await executor.executeStep(step, plan, signal);
        };
      }
    }
  }
  
  // 继续原有逻辑
  return runAgentTurnImpl(history, userText, restOptions);
}
```

**关键集成点 2：过滤只读工具**

```typescript
// 新增辅助函数
function filterReadOnlyTools(tools: Tool[]): Tool[] {
  const READ_ONLY_TOOLS = new Set([
    "read", "grep", "find", "ls", 
    "git_status", "git_diff",
    "codebase_search", "codebase_read", "codebase_explain",
    "web_search", "fetch_content"
  ]);
  
  return tools.filter(tool => READ_ONLY_TOOLS.has(tool.name));
}
```

**关键集成点 3：System Prompt 阶段感知**

```typescript
// 修改 buildSystemPrompt
export function buildSystemPrompt(
  mode?: PermissionMode,
  phase?: SessionPhase
): string {
  const base = [/* 现有内容 */];
  
  // 添加阶段特定指令
  if (phase === "planning") {
    base.push(`
### 当前阶段：规划阶段 (Planning)

你的任务是分析需求并生成执行计划，而不是直接执行。

请按以下格式输出计划：

\`\`\`json
{
  "summary": "计划摘要",
  "steps": [
    {
      "description": "步骤描述",
      "tool": "工具名",
      "arguments": { /* 工具参数 */ },
      "risk": "safe|medium|high",
      "rationale": "为什么需要这一步"
    }
  ],
  "risks": [
    {
      "category": "file_modification|command_execution|network_access",
      "level": "low|medium|high",
      "description": "风险描述",
      "mitigation": "缓解措施"
    }
  ],
  "executionMode": "manual|auto|bypass"
}
\`\`\`

注意：你当前无权执行写操作，只能使用只读工具收集信息。
    `);
  }
  
  if (phase === "review") {
    base.push(`
### 当前阶段：审查阶段 (Review)

计划已生成，等待用户审批。你可以：
- 回答用户对计划的疑问
- 根据反馈修改计划
- 等待用户批准后自动进入执行阶段
    `);
  }
  
  if (phase === "acting") {
    base.push(`
### 当前阶段：执行阶段 (Acting)

正在执行已批准的计划。请严格按照计划步骤执行，每步完成后报告结果。
    `);
  }
  
  return base.join("\n\n");
}
```

#### 实施检查清单

**第一步：修改 Loop（1.5天）**

- [ ] 添加 `session?: Session` 参数到 [`TurnOptions`](src/loop.ts)
- [ ] 实现阶段检测逻辑
- [ ] 实现 `filterReadOnlyTools()` 函数
- [ ] 集成 [`PlanGenerator.parseFromLlmOutput()`](src/plan-act/plan-generator.ts)
- [ ] 更新 [`buildSystemPrompt()`](src/loop.ts) 支持阶段感知

**第二步：Server 调用 Loop（0.5天）**

- [ ] 在 [`src/server.ts`](src/server.ts) 的消息处理中传递 `session` 参数
- [ ] 确保 Planning 阶段自动触发计划生成
- [ ] 确保 Acting 阶段使用 PlanExecutor

**第三步：测试（1天）**

- [ ] 创建 `test/loop-plan-act.test.ts`
- [ ] 测试 Planning 阶段的只读限制
- [ ] 测试计划自动检测和解析
- [ ] 测试 Acting 阶段的工具白名单

---

## 🔄 完整开发流程示例

### 场景：用户请求 "修改 package.json 添加新 script"

```typescript
// 1. 用户发送消息
POST /api/sessions/abc123/messages
Body: { text: "修改 package.json 添加新 script" }

// Server 处理：
session.phase = "planning";  // 初始化为 planning
await runAgentTurn(messages, userText, { session, ... });

// 2. Loop 检测到 planning 阶段
// - 强制 permissionMode = "plan"
// - 过滤只读工具
// - LLM 生成计划（JSON 格式）

// 3. onEvent 检测到计划生成
session.currentPlan = parsedPlan;
session.phase = "review";
emit({ type: "plan_generated", plan });

// 4. 前端显示计划，用户审查
// 用户点击"批准"按钮

// 5. 批准计划
POST /api/sessions/abc123/plan/approve

session.phase = "acting";
plan.status = "approved";

// 6. 执行计划
POST /api/sessions/abc123/execute

executor.execute(plan):
  - step 1: read package.json ✓
  - step 2: write package.json (需要权限) ✓
  - step 3: bash npm run --silent ✓

session.phase = "completed";

// 7. 返回结果
emit({ type: "all_steps_completed" });
```

---

## 📋 实施时间线

### 本周计划（3-4天）

| 天数 | 任务 | 产出 |
|------|------|------|
| Day 1 | API 端点实现 | 7 个新端点 + 事件集成 |
| Day 2 | Loop 集成（阶段检测 + 计划解析） | runAgentTurn 修改 + filterReadOnlyTools |
| Day 3 | Loop 集成（执行控制 + System Prompt） | buildSystemPrompt 更新 + 工具白名单 |
| Day 4 | 集成测试 + 调试 | 端到端流程验证 |

### 验收标准

**功能验收：**
- [ ] 可以通过 API 生成计划
- [ ] Planning 阶段只能使用只读工具
- [ ] 可以批准/拒绝/修改计划
- [ ] Acting 阶段按计划执行工具
- [ ] 所有阶段转换正确
- [ ] 计划持久化正常

**测试验收：**
- [ ] 新增测试文件覆盖率 > 80%
- [ ] 所有现有测试继续通过
- [ ] 端到端流程测试通过

**代码质量：**
- [ ] 通过 TypeScript 类型检查
- [ ] 通过 ESLint 检查
- [ ] 代码有适当注释

---

## 🎨 后续阶段预览

### Phase 4: TUI/Web UI 更新（3天）
- 阶段指示器组件
- 计划展示面板
- 审批交互按钮
- 执行进度可视化

### Phase 5: 文档与向后兼容（2天）
- README 更新
- 迁移指南
- 功能开关 `ENABLE_PLAN_ACT_WORKFLOW`
- 演示视频

---

## 💡 开发建议

### 优先级排序

1. **先 API 后 UI**：先实现后端逻辑，用 API 测试工具验证
2. **增量实现**：每个端点实现后立即测试
3. **保持向后兼容**：确保现有的四模式系统继续工作

### 调试技巧

```bash
# 启动开发服务器
npm run dev

# 测试 API
curl -X POST http://localhost:3001/api/sessions \
  -H "Content-Type: application/json"

# 查看日志
tail -f ~/.mini-agent/sessions/*.log

# 运行测试
npm test -- --grep "plan-act"
```

### 常见问题

**Q: 如何在 Planning 阶段触发计划生成？**
A: 不需要手动触发，Loop 的 `onEvent` 回调会自动检测 LLM 输出中的计划格式。

**Q: 如何处理计划解析失败？**
A: PlanGenerator 会返回 null，继续等待更完整的输出。可以设置超时或最大重试次数。

**Q: Acting 阶段工具调用失败怎么办？**
A: PlanExecutor 会捕获错误，触发 `step_failed` 事件，可以选择重新规划。

---

## 📚 参考文档

- [原始设计方案](plans/permission-plan-act-refactor.md)
- [当前进度](docs/plan-act-progress.md)
- [检查清单](plans/plan-act-checklist.md)

---

**下一步行动：开始实施 Phase 2 的 API 端点！** 🚀

建议从 [`src/server.ts`](src/server.ts) 的 `POST /api/sessions/:id/plan/approve` 开始，因为这是最核心的流程。
