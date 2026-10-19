# 🚀 bg-tasks 系统升级建议

基于当前实现的全面评估（2026-10-19），以下是按优先级排序的升级建议。

## ✅ 已完成的功能

- [x] Gap 1: TUI 浮动监控面板（BgTaskLivePanel）
- [x] Gap 2: bg_send 控制键支持（Ctrl+C/D/Z + 方向键）
- [x] Gap 3: 交互式输入错误处理
- [x] LLM 自动化策略配置（AGENTS.md）
- [x] HTTP API 完整实现（7个端点）
- [x] 710 行测试代码覆盖

---

## 🎯 高优先级升级（建议立即实施）

### 1. **Web UI 后台任务面板** ⭐⭐⭐⭐⭐

**问题**：
- TUI 有 `BgTaskLivePanel.tsx`（浮动面板）
- Web UI 有完整的 HTTP API（7个端点）
- **但 Web UI 缺少对应的前端组件**

**影响**：
- Web 用户无法可视化监控后台任务
- 只能通过 API 手动查询状态

**方案**：
```typescript
// apps/web/src/components/BackgroundTasksPanel.tsx
- 复用 TUI 的 UI 逻辑（列表 + 日志尾部）
- 使用 React + fetch() 替代 Ink
- 实时刷新（polling 或 WebSocket）
- 操作按钮：Kill / Send Input / View Full Logs
```

**预计工作量**：4-6 小时

---

### 2. **性能优化：增量刷新** ⭐⭐⭐⭐

**问题**：
```typescript
// src/tui/components/BgTaskLivePanel.tsx:50
const timer = setInterval(() => void refresh(), 1500);

// refresh() 每 1.5s 执行：
// 1. manager.list() — 完整任务列表
// 2. manager.logs(selectedTask) — 读取日志文件
```

**影响**：
- 10 个后台任务时，每 1.5s 读取 11 次文件（list + logs）
- CPU 和磁盘 I/O 浪费

**方案**：
```typescript
// 增量更新策略
1. 仅刷新状态变化的任务（compareTaskStates）
2. 日志使用 offset 增量读取（避免重复读取已显示内容）
3. 自适应刷新间隔（running: 1s, idle: 5s）

// 伪代码
const lastStates = useRef<Map<string, TaskState>>();
const refresh = () => {
  const current = await manager.list();
  const changed = current.filter(t => 
    !lastStates.has(t.id) || 
    lastStates.get(t.id).status !== t.status
  );
  // 仅更新变化的任务
};
```

**预计工作量**：2-3 小时

---

### 3. **错误恢复机制** ⭐⭐⭐⭐

**问题**：
- 当前 Process backend 在 manager 重启后无法交互
- tmux 意外退出时任务丢失
- 没有崩溃任务的自动重试机制

**方案**：
```typescript
// 1. 任务状态持久化增强
type TaskMeta = {
  restartable: boolean;     // 是否可重启
  maxRetries: number;       // 最大重试次数
  currentRetry: number;     // 当前重试次数
  lastCrashReason?: string; // 上次崩溃原因
};

// 2. Manager 启动时恢复
async initialize() {
  const orphans = await this.detectOrphanedTasks();
  for (const task of orphans) {
    if (task.restartable && task.currentRetry < task.maxRetries) {
      await this.restart(task.id);
    }
  }
}

// 3. 健康检查
setInterval(async () => {
  for (const task of runningTasks) {
    if (!await this.isProcessAlive(task.pid)) {
      await this.handleCrash(task);
    }
  }
}, 5000);
```

**预计工作量**：6-8 小时

---

## 🔧 中优先级升级（优化体验）

### 4. **任务依赖管理** ⭐⭐⭐

**场景**：
```bash
# 用户：先构建，再运行测试
bg_start("npm run build")    # task-build-123
bg_start("npm test")          # task-test-456

# 问题：测试可能在构建完成前开始
```

**方案**：
```typescript
// bg_start 增加 depends_on 参数
bg_start({
  command: "npm test",
  depends_on: ["task-build-123"], // 等待前置任务完成
  strategy: "all" | "any"         // 全部完成 or 任一完成
})

// Manager 自动排队
class BgTaskManager {
  async start(input: StartTaskInput) {
    if (input.depends_on) {
      await this.wait(input.depends_on, "all");
    }
    return this.actualStart(input);
  }
}
```

**预计工作量**：3-4 小时

---

### 5. **任务分组与批量操作** ⭐⭐⭐

**场景**：
```bash
# 用户启动 5 个测试任务
bg_start("npm test -- test1.ts") # bg_test_1
bg_start("npm test -- test2.ts") # bg_test_2
...

# 想要一次性停止所有测试任务
bg_kill_group("test")  # 杀掉所有 bg_test_* 任务
```

**方案**：
```typescript
// 1. 任务标签系统
bg_start({
  command: "npm test -- test1.ts",
  tags: ["test", "integration", "auth-module"]
})

// 2. 批量操作工具
bg_kill_by_tag({ tag: "test" })
bg_status_by_tag({ tag: "integration" })
bg_wait_by_tag({ tag: "build", mode: "all" })
```

**预计工作量**：4-5 小时

---

### 6. **日志搜索与过滤** ⭐⭐⭐

**问题**：
- 当前只能查看日志尾部（last N lines）
- 无法搜索错误信息
- 大型日志文件（>10MB）读取慢

**方案**：
```typescript
// 1. 增加日志搜索 API
bg_logs({
  taskId: "bg_test_123",
  search: "ERROR",      // 搜索关键词
  context: 3,          // 上下文行数
  level: "error"       // 日志级别过滤
})

// 2. 结构化日志解析
// 自动识别常见格式：
// - [ERROR] message
// - 2024-10-19 17:00:00 ERROR message
// - {"level":"error","msg":"..."}

// 3. 日志分页
bg_logs({
  taskId: "bg_test_123",
  offset: 1000,        // 字节偏移
  limit: 10000,        // 读取上限
  reverse: true        // 从文件末尾开始
})
```

**预计工作量**：5-6 小时

---

## 💡 低优先级升级（未来增强）

### 7. **任务调度策略** ⭐⭐

**场景**：
- 同时运行 20 个后台任务 → CPU 占满
- 需要控制并发数量

**方案**：
```typescript
// bg_start 增加调度参数
bg_start({
  command: "npm run heavy-task",
  priority: "high" | "normal" | "low",
  max_concurrent: 4,  // 同类任务最多并发数
  cpu_limit: 50,      // CPU 使用限制（%）
  memory_limit: "2GB" // 内存限制
})
```

---

### 8. **任务快照与回放** ⭐⭐

**场景**：
- 构建失败，想要复现
- 需要保存当时的完整状态

**方案**：
```typescript
// 保存任务快照
bg_snapshot({
  taskId: "bg_build_123",
  include: ["logs", "env", "cwd", "command", "exit_code"]
})
// → 生成 .bg-tasks/snapshots/bg_build_123_20261019.json

// 从快照恢复
bg_replay({
  snapshot: ".bg-tasks/snapshots/bg_build_123_20261019.json"
})
```

---

### 9. **WebSocket 实时推送** ⭐⭐

**问题**：
- Web UI 当前只能 polling（每 N 秒查询一次）
- 延迟高、服务器负载大

**方案**：
```typescript
// Server 端
io.on("connection", (socket) => {
  socket.on("subscribe", ({ taskId }) => {
    manager.on("task:update", (task) => {
      if (task.id === taskId) {
        socket.emit("task:update", task);
      }
    });
  });
});

// Web UI
const ws = new WebSocket("/api/background-tasks/stream");
ws.onmessage = (event) => {
  const task = JSON.parse(event.data);
  updateTaskInUI(task);
};
```

---

### 10. **任务模板库** ⭐

**场景**：
- 常用命令需要重复输入

**方案**：
```json
// .bg-tasks/templates.json
{
  "build": {
    "command": "npm run build",
    "timeout": 300,
    "tags": ["build"]
  },
  "test": {
    "command": "npm test",
    "timeout": 600,
    "tags": ["test"]
  }
}

// 使用模板
bg_start({ template: "build" })
```

---

## 📊 优先级总结

| 升级项 | 优先级 | 工作量 | ROI | 推荐顺序 |
|--------|--------|--------|-----|----------|
| Web UI 面板 | ⭐⭐⭐⭐⭐ | 4-6h | 高 | **1** |
| 增量刷新 | ⭐⭐⭐⭐ | 2-3h | 高 | **2** |
| 错误恢复 | ⭐⭐⭐⭐ | 6-8h | 高 | **3** |
| 任务依赖 | ⭐⭐⭐ | 3-4h | 中 | 4 |
| 任务分组 | ⭐⭐⭐ | 4-5h | 中 | 5 |
| 日志搜索 | ⭐⭐⭐ | 5-6h | 中 | 6 |
| 任务调度 | ⭐⭐ | 8-10h | 低 | 7 |
| 快照回放 | ⭐⭐ | 6-8h | 低 | 8 |
| WebSocket | ⭐⭐ | 4-6h | 低 | 9 |
| 模板库 | ⭐ | 2-3h | 低 | 10 |

---

## 🎯 建议实施路线

### 第一阶段（1-2 周）
1. Web UI 后台任务面板（补齐功能对等性）
2. 性能优化：增量刷新（解决当前性能瓶颈）

### 第二阶段（2-3 周）
3. 错误恢复机制（提高系统可靠性）
4. 任务依赖管理（增强工作流能力）

### 第三阶段（按需）
5-10. 根据用户反馈和实际使用场景决定

---

## 🔍 技术债务

当前代码库中的已知问题：

1. **76 个 TODO/FIXME 标记**（全项目）
   - 建议：定期清理，转化为 GitHub Issues

2. **测试覆盖率未知**
   - 当前：710 行测试代码
   - 建议：运行 `npm run test:coverage` 获取覆盖率报告
   - 目标：bg-tasks 模块 ≥80% 覆盖率

3. **缺少性能基准测试**
   - 建议：添加 benchmark 测试
   - 场景：100 个并发任务、1GB 日志文件、1000 次刷新

4. **文档不完整**
   - 当前：README.md 88 行
   - 缺少：架构图、API 参考文档、最佳实践指南

---

## 📝 下一步行动

**立即可做：**
1. Review 本文档，确认优先级
2. 创建 GitHub Issues 跟踪各个升级项
3. 估算团队可投入的时间

**建议从这里开始：**
```bash
# 1. 创建 Web UI 面板组件（最高优先级）
mkdir -p apps/web/src/components
touch apps/web/src/components/BackgroundTasksPanel.tsx

# 2. 添加性能监控（为优化提供数据）
npm install --save-dev benchmark

# 3. 补充测试覆盖率
npm run test:coverage
```

---

生成时间：2026-10-19 17:27  
基于代码版本：mini-agent-loop (latest)  
评估范围：bg-tasks 模块 + TUI + Web UI + HTTP API
