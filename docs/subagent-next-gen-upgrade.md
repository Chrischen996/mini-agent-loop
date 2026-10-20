# Subagent 下一代升级方案

> **当前状态**：Subagent 基础设施已完善（独立上下文、profile、maxTurns、partial results、auto-continue），测试覆盖 99 个用例全部通过。
>
> **升级目标**：从"工具级子代理"升级到"协作式智能体编排"，支持更复杂的多 Agent 场景。

---

## 一、当前架构评估

### 已有能力（✅）
- ✅ 独立上下文隔离（子代理不污染父 agent）
- ✅ Profile 系统（预定义专家角色）
- ✅ 部分结果支持（`success=false` + `partial=true`）
- ✅ 自动续写（auto-continue on truncation）
- ✅ 预算控制（token/cost budget）
- ✅ 思考模式升级（adaptive thinking escalation）
- ✅ 读写权限隔离（readOnly profiles）

### 架构限制（⚠️）
- ⚠️ 同步阻塞：父 agent 必须等子代理完成才能继续
- ⚠️ 单向通信：父→子传递任务，子→父返回结果，无中途交互
- ⚠️ 无状态持久化：子代理中断后无法恢复
- ⚠️ 缺乏协作机制：多个子代理之间无法通信/共享状态
- ⚠️ 无结果评分：父 agent 难以判断子代理结果质量
- ⚠️ 串行瓶颈：`subagent_batch` 虽然并发，但无任务依赖图

---

## 二、升级方向与优先级

### 🚀 Phase 1：增强可观测性（1-2 天）
**目标**：让父 agent 和开发者看清子代理内部发生了什么

#### 1.1 进度流式事件
```typescript
// 新增事件类型
type SubagentProgressEvent = {
  type: "subagent_progress";
  subagentId: string;
  turnIndex: number;
  currentAction: string;  // "Searching codebase" / "Writing tests"
  toolsUsed: string[];
  partialResult?: string; // 中间产物预览
  confidence?: number;    // 0-1，子代理对当前方向的信心
};
```

**实现要点**
- 子代理在每个 turn 结束时触发 `subagent_progress` 事件
- TUI 显示实时进度条：`[Subagent: researcher] Turn 3/5 → Analyzing dependencies...`
- 父 agent 可选择监听进度并提前中止（如检测到错误方向）

#### 1.2 结果质量评分
```typescript
type SubagentResult = {
  // ... 现有字段
  qualityScore?: {
    completeness: number;  // 0-1，任务完成度
    correctness: number;   // 0-1，结果正确性（基于验证）
    confidence: number;    // 0-1，子代理自评信心
    explanation: string;   // 评分理由
  };
};
```

**实现要点**
- 子代理在返回前进行自评（通过额外的 LLM 调用或启发式规则）
- 父 agent 根据 `qualityScore` 决定是否接受结果、重试、或换模型

**收益**：减少父 agent 的验收成本，快速筛选低质量结果

---

### 🔥 Phase 2：异步编排与协作（3-5 天）
**目标**：支持复杂任务的并行分解与协作

#### 2.1 异步子代理调度器
```typescript
// 异步子代理 API
const subagentHandle = await spawnSubagentAsync({
  profile: "coder",
  task: "Implement user auth module",
  // 父 agent 不阻塞，立即拿到 handle
});

// 父 agent 可以继续做其他事情
await doOtherWork();

// 稍后获取结果
const result = await subagentHandle.wait();
// 或者提前终止
await subagentHandle.abort("Requirements changed");
```

**架构设计**
- 新增 `SubagentScheduler` 管理所有运行中的子代理
- 每个子代理有独立的状态机：`queued → running → completed | failed | aborted`
- 支持父 agent 查询状态：`scheduler.getStatus(subagentId)`
- 支持批量等待：`scheduler.waitAll([id1, id2, id3])`

#### 2.2 任务依赖图（DAG）
```typescript
// 定义任务依赖关系
const plan = {
  tasks: [
    { id: "t1", profile: "researcher", task: "Analyze codebase" },
    { id: "t2", profile: "coder", task: "Implement feature A", dependsOn: ["t1"] },
    { id: "t3", profile: "coder", task: "Implement feature B", dependsOn: ["t1"] },
    { id: "t4", profile: "tester", task: "Integration test", dependsOn: ["t2", "t3"] },
  ],
};

// 自动调度执行（t2 和 t3 并行）
const results = await scheduler.executePlan(plan);
```

**实现要点**
- 拓扑排序自动确定执行顺序
- 一个任务失败后，依赖它的任务自动跳过或重试
- 支持动态依赖：`t2` 的结果影响 `t3` 的输入

**收益**：父 agent 只需描述"做什么"，不需关心"谁先谁后"

#### 2.3 子代理间通信（共享黑板）
```typescript
// 子代理 A 写入共享状态
await sharedContext.set("api_spec", { endpoints: [...] });

// 子代理 B 读取
const spec = await sharedContext.get("api_spec");
```

**架构设计**
- 引入 `SharedContext` 作为子代理间的共享内存
- 支持 key-value 存储、消息队列、事件总线三种模式
- 权限控制：profile 可限制哪些 key 可读写

**收益**：支持"生产者-消费者"模式（如研究员产出规格 → 开发者实现 → 审查员验收）

---

### ⚡ Phase 3：智能决策与自适应（5-7 天）
**目标**：子代理系统能自主优化执行策略

#### 3.1 失败自动恢复（Retry with Context）
```typescript
const result = await spawnSubagent({
  profile: "coder",
  task: "Fix bug #123",
  retryPolicy: {
    maxRetries: 3,
    onFailure: async (attempt, error, history) => {
      // 每次重试时注入失败原因
      return {
        additionalContext: `Previous attempt ${attempt} failed: ${error}. Avoid this approach.`,
        // 可选：换模型或调整参数
        model: attempt >= 2 ? "gpt-4" : undefined,
      };
    },
  },
});
```

**实现要点**
- 子代理失败后，自动提取失败原因（从错误消息、工具调用历史）
- 重试时将失败经验注入 context，避免重复错误
- 支持逐步升级策略：第 1 次用快速模型，第 2 次用强模型

#### 3.2 动态 Profile 选择
```typescript
// 父 agent 不确定该用哪个 profile 时
const bestProfile = await scheduler.selectProfile({
  task: "Optimize database query performance",
  candidates: ["researcher", "coder", "dba_expert"],
  // 系统根据任务描述自动选择最合适的 profile
});
```

**实现要点**
- 训练一个轻量级分类器（或用 LLM zero-shot 分类）
- 根据任务关键词、历史成功率推荐 profile
- 支持"试探性运行"：同时启动 2 个 profile，取更快完成的

#### 3.3 学习型子代理（经验积累）
```typescript
// 记录每次子代理执行的成功/失败模式
scheduler.recordExecution({
  profileName: "coder",
  taskType: "implement_api",
  success: true,
  toolsUsed: ["search_code", "edit_file", "run_tests"],
  duration: 120,
  qualityScore: 0.9,
});

// 未来执行时自动优化
// 例如：检测到 "implement_api" 类型任务 → 自动增加 token 预算
```

**实现要点**
- 引入 `ExecutionHistory` 数据库（SQLite 或内存）
- 记录任务类型、profile、成功率、平均用时、常用工具
- 根据历史数据自动调整：预算、超时时间、推荐工具集

---

### 🌟 Phase 4：高级编排模式（长期）
**目标**：支持生产级多智能体系统

#### 4.1 Swarm 模式（群体智能）
- 启动 N 个子代理并行探索同一问题
- 投票选出最佳方案（类似 AlphaCode）
- 适用于"没有明确正确答案"的创意任务

#### 4.2 Debate 模式（对抗辩论）
- 两个子代理持不同立场（如"应该用微服务" vs "单体架构"）
- 通过多轮辩论收敛到最优方案
- 第三个子代理作为裁判

#### 4.3 Pipeline 模式（流水线）
- 子代理串行处理，每个专注一个阶段
- 例如：需求分析 → 设计 → 编码 → 测试 → 部署
- 每个阶段的输出自动成为下一阶段的输入

#### 4.4 Supervisor 模式（主管-工人）
- 一个"主管"子代理负责任务拆解和协调
- 多个"工人"子代理执行具体任务
- 主管根据工人反馈动态调整计划

---

## 三、技术实现路线图

### Week 1: 可观测性升级
- [ ] 实现 `SubagentProgressEvent` 流式事件
- [ ] TUI 显示子代理实时进度
- [ ] 添加结果质量评分机制
- [ ] 更新测试覆盖（进度事件、评分逻辑）

### Week 2: 异步调度基础
- [ ] 实现 `SubagentScheduler` 状态管理器
- [ ] 添加 `spawnSubagentAsync()` API
- [ ] 支持 `handle.wait()` / `handle.abort()`
- [ ] 更新文档和示例代码

### Week 3: 任务依赖图
- [ ] 实现 DAG 拓扑排序
- [ ] 支持 `executePlan(tasks)` 自动调度
- [ ] 处理失败传播与回滚
- [ ] 可视化依赖图（TUI / Web UI）

### Week 4: 协作与共享
- [ ] 实现 `SharedContext` 共享黑板
- [ ] 支持子代理间消息传递
- [ ] 权限控制与访问审计
- [ ] 示例：多 Agent 协作编写大型项目

### Week 5+: 智能决策
- [ ] 失败自动恢复与经验注入
- [ ] 动态 Profile 选择
- [ ] 执行历史记录与学习
- [ ] 高级编排模式原型（Swarm / Debate）

---

## 四、关键技术挑战

### 挑战 1：异步状态管理
**问题**：Node.js 单线程，如何高效管理多个并发子代理？
**方案**：
- 使用 `Promise` + `EventEmitter` 实现异步编排
- 每个子代理在独立的 `async` 函数中运行
- 通过 `scheduler.tick()` 轮询状态变化（或基于事件驱动）

### 挑战 2：子代理间通信开销
**问题**：共享状态可能导致竞态条件或性能瓶颈
**方案**：
- 使用不可变数据结构（Immutable.js）
- 消息传递而非共享内存（Actor 模型）
- 限制共享 key 的数量和大小

### 挑战 3：失败恢复的策略选择
**问题**：如何判断是"重试"还是"换模型"还是"放弃"？
**方案**：
- 启发式规则：token 超限→增加预算；语法错误→重试；逻辑错误→换模型
- 基于历史成功率的贝叶斯决策
- 允许用户自定义 `retryPolicy` 回调

### 挑战 4：测试复杂异步流程
**问题**：DAG、并发、重试的组合测试场景爆炸
**方案**：
- 使用 Mock LLM 确保可重现
- 快照测试（snapshot testing）记录调度序列
- 性能基准测试（benchmark）防止回归

---

## 五、可选的"快速原型"路径

如果想快速验证价值，可以先实现 **最小可用版本（MVP）**：

### MVP 范围
1. ✅ 异步 API（`spawnSubagentAsync` + `handle.wait()`）
2. ✅ 简单并行（启动 3 个子代理，等待全部完成）
3. ✅ 进度事件（TUI 显示"Subagent 2/3 完成"）
4. ✅ 基础重试（失败后自动重试 1 次）

### MVP 实现时间：2-3 天
- **Day 1**：`SubagentScheduler` + 异步 API
- **Day 2**：进度事件 + TUI 集成
- **Day 3**：重试逻辑 + 测试

### MVP 验证场景
```typescript
// 父 agent 指令："并行研究 3 个竞品的架构，然后总结"
const handles = await Promise.all([
  spawnSubagentAsync({ profile: "researcher", task: "Research Product A" }),
  spawnSubagentAsync({ profile: "researcher", task: "Research Product B" }),
  spawnSubagentAsync({ profile: "researcher", task: "Research Product C" }),
]);

// TUI 显示：[1/3 完成] [2/3 完成] [3/3 完成]
const results = await Promise.all(handles.map(h => h.wait()));

// 父 agent 汇总结果
summarize(results);
```

---

## 六、投入产出分析

| 升级方向 | 开发成本 | 用户价值 | 技术风险 |
|---------|---------|---------|---------|
| 进度流式事件 | 🟢 低 (1天) | 🟡 中 (改善体验) | 🟢 低 |
| 结果质量评分 | 🟡 中 (2天) | 🔴 高 (减少验收) | 🟡 中 (评分准确性) |
| 异步调度 | 🟡 中 (3天) | 🔴 高 (支持并行) | 🟡 中 (状态管理) |
| 任务依赖图 | 🔴 高 (5天) | 🔴 高 (复杂编排) | 🔴 高 (调度逻辑) |
| 共享黑板 | 🟡 中 (3天) | 🟡 中 (协作场景) | 🟡 中 (竞态条件) |
| 失败恢复 | 🟡 中 (2天) | 🔴 高 (提升成功率) | 🟢 低 |
| 动态 Profile | 🟡 中 (2天) | 🟡 中 (自动化决策) | 🟡 中 (选择准确性) |
| 学习型子代理 | 🔴 高 (7天) | 🟡 中 (长期优化) | 🔴 高 (数据积累) |

### 推荐优先级（ROI 排序）
1. **异步调度** - 立即解锁并行能力
2. **失败恢复** - 显著提升成功率
3. **进度事件** - 改善用户体验
4. **结果质量评分** - 减少人工验收
5. **任务依赖图** - 支持复杂场景
6. **共享黑板** - 解锁协作模式
7. **动态 Profile** - 智能决策辅助
8. **学习型子代理** - 长期演进

---

## 七、兼容性与迁移

### 向后兼容
- 现有同步 API 保持不变（`subagent(...)` 继续工作）
- 异步 API 作为可选增强（`spawnSubagentAsync(...)` 新增）
- 所有现有测试必须继续通过

### 迁移指南
```typescript
// 旧代码（同步）
const result = await tools.subagent({
  profile: "coder",
  task: "Implement feature",
});

// 新代码（异步，可选）
const handle = await tools.spawnSubagentAsync({
  profile: "coder",
  task: "Implement feature",
});
const result = await handle.wait();  // 行为完全一致

// 新代码（并行，新能力）
const [r1, r2] = await Promise.all([
  tools.spawnSubagentAsync({ ... }),
  tools.spawnSubagentAsync({ ... }),
]);
```

---

## 八、总结

当前 Subagent 已经是一个**生产级的工具**，但还处于"单个专家顾问"阶段。

升级方向：
- **Phase 1（可观测性）** → 看得清发生了什么
- **Phase 2（异步编排）** → 多个专家并行工作
- **Phase 3（智能决策）** → 系统自己优化执行
- **Phase 4（高级模式）** → 群体智能、辩论、流水线

**如果只选一个方向**：优先做 **异步调度 + 任务依赖图**，这是其他所有高级功能的基础。

**如果想快速见效**：先做 **MVP（异步 + 进度 + 重试）**，2-3 天可落地，立即改善大任务体验。
