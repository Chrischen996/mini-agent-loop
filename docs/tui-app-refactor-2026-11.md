# App.tsx 拆分重构 — 变更说明与后续事项

> 日期：2026-11-23
> 范围：`src/tui/App.tsx`（3402 行）→ 197 行根容器 + 12 个职责单一的模块
> 原则：**只搬代码、不改变任何运行时逻辑**。所有命令分支顺序、副作用时机、状态流转保持逐字一致。

---

## 一、这次做了什么

### 1.1 一句话总结

把「多 Agent 根容器」和「单会话视图」拆成两个组件；再把单会话里四块最大的内联逻辑（命令分发、回合执行、流式输出、布局预算）提成模块。`App.tsx` 从 3402 行降到 197 行。

### 1.2 文件级变更

| 文件 | 行数 | 性质 | 职责 |
|---|---|---|---|
| `src/tui/App.tsx` | **197**（原 3402） | 重写 | 多 Agent 列表、Dashboard 开关、worktree 隔离派发 |
| `src/tui/AgentSessionApp.tsx` | 1995 | **新增** | 单个会话：reducer 接线 + JSX |
| `src/tui/session/command-cascade.ts` | 659 | **新增** | 斜杠命令路由（原 `handleSubmit` 的 477 行瀑布流） |
| `src/tui/session/turn-execution.ts` | 462 | **新增** | 一次 Agent 回合：自动续跑、中断、超时、plan/exec 收尾 |
| `src/tui/session/session-restore.ts` | 244 | **新增** | resume / fork / 外部会话导入 |
| `src/tui/session/props.ts` | 69 | **新增** | `AppProps` / `AgentSessionAppProps`（消除循环依赖） |
| `src/tui/hooks/useStreamBursts.ts` | 356 | **新增** | 静态行直写终端、seal 账本、resize 重印 |
| `src/tui/hooks/useSessionLayout.ts` | 195 | **新增** | feed / picker / prompt 高度预算 |
| `src/tui/hooks/useTerminalSize.ts` | 42 | **新增** | 终端尺寸（原来有两份完全相同的实现） |
| `src/tui/hooks/useLazyRef.ts` | 14 | **新增** | 懒初始化 ref |
| `src/tui/hooks/useGoalStatusTicker.ts` | 19 | **新增** | 1 Hz goal 计时器 |
| `src/tui/subagent-prompts.ts` | 76 | **新增** | 后台完成提示词信封（含不可信数据包裹） |
| `src/tui/turn-messages.ts` | 21 | **新增** | LLM 超时提示文案 |
| `src/tui/session-workspace.ts` | 50 | **新增** | 会话工作区路径校验（防逃逸） |

`git diff --stat`：22 个已跟踪文件，`+892 / -3354`。

### 1.3 消除的重复

| 重复内容 | 原来 | 现在 |
|---|---|---|
| 终端 resize 监听 | `App.tsx` + `App.tsx` 内两份**逐字相同**的实现 | `useTerminalSize` 一份 |
| `formatLlmTimeoutMessage` | `App.tsx` 一份 + `tui-core/turn-runner.ts` 一份 | `turn-messages.ts` 一份 |
| `tui-turn-helpers.test.ts` 里的格式化函数 | **测试里复制粘贴了一份假实现** | 改为导入真实实现 |
| 后台任务完成提示词 | `App.tsx` 内联模板字符串 | `makeBgTaskCompletionPrompt` |
| `SEND_NOW_WAIT_TOOLS` / `MAX_AUTO_CONTINUES` / 续跑文案 | 各自散落 | 单一来源 |
| `handleSubmit` 依赖数组 | 31 项，其中 **13 项是死依赖** | 19 项，全部有效 |

### 1.4 顺手修掉的两个既有缺陷

这两处都**不是**重构引入的，是复查时发现的：

**① 测试偶发失败（1/5 ~ 1/6 概率红）**

`test/tui-store-slices.test.ts` 声称会屏蔽时间戳，但 `blankTimestamps` 只处理**嵌套对象的 key**；`taskStartedAt` / `taskDurationMs` 是 `TuiState` 的**顶层标量**，从未被真正屏蔽：

```
action[3] LOOP_EVENT: field taskDurationMs diverged
  A: 0
  B: 1        ← 两次独立 reducer 运行相差 1ms
```

修复：顶层字段循环显式跳过 `TIMESTAMP_FIELDS`，并把派生时长 `taskDurationMs` 加入该集合。修复前 5 次红 1 次，修复后 **20 次连续 0 失败**。

**② `message-viewport.ts` 里重复声明的变量**

工作区里有一段未完成的编辑，导致 `hasMissingEarlierTranscript` 被声明两次，`tsc` 直接报错。保留了更严格的那一份（带 `index !== undefined` 判断），删掉旧副本。

> ⚠️ 这一处需要你确认：如果你的编辑本意是别的，请回看 `git diff src/tui/message-viewport.ts`。

---

## 二、验证结果

| 检查 | 结果 |
|---|---|
| `npx tsc --noEmit` | ✅ 通过 |
| `npx tsc --noEmit --noUnusedLocals`（改动文件） | ✅ **0** 处未使用声明 |
| `npm run build` | ✅ 成功（920ms + 17ms） |
| `npx tsx --test "test/tui-*.test.ts"` | ✅ **661 / 661 通过** |
| 新增测试 | ✅ 36 例全通过 |
| `npm test` 全量 | ⚠️ 74 失败，**与重构前基线完全同集合** |

### 关于那 74 个失败

全部是沙箱权限错误，与本次改动无关：

- `EPERM connect 127.0.0.1` — server / web-ui 测试需要本地端口
- `EPERM scandir ~/.claude/skills` — skills 测试
- `EPERM open ~/.mini-agent/models.json` — profile 测试
- `git index.lock exists` — git-workflow 测试

基线对比：重构前 2049 测试 / 74 失败；重构后 2084 测试 / 74 失败。**失败集合一致**。

### 命令顺序等价性验证

这是重构最容易出错的地方，做了结构化对比。原版与重构版各 16 个命令检查点，顺序**逐条一致**：

```
foreignResume → resume → /sessions → bg-send → /bg-tasks → /tasks-pane
→ mcp → /exit → /clear → /context → todo → copy → /help → init
→ 直连工具 → unknown
```

---

## 三、还需要处理的（按优先级）

### P1 — 建议尽快处理

**1. 工作区里混有无关改动，提交前需要拆分**

当前工作区不是干净的重构分支。以下文件含有**本次任务之外**的修改：

| 文件 | 内容 |
|---|---|
| `src/loop.ts` | `activeRuntimeRef.history = messages` + 4 处 `messages.push` 移除 |
| `src/tui/state.ts` | `streamSealPending` 字段、assistant 消息去重逻辑 |
| `src/tui/message-viewport.ts` | seal 切片、缓存 key 扩展 |
| `src/tui/incremental-renderer.ts` | 渲染管线调整 |
| `src/tui/components/MessageFeed.tsx` | 12 行改动 |
| `src/tui/cursor-probe.ts` | 超时 150ms → 300ms |
| `test/*`（8 个文件） | 配套测试 |

这些是「流式输出去重」相关的另一条工作线。**建议分两个 commit 提交**，否则回滚重构时会连带丢失那条线的修复。

**2. `1.md` 是未跟踪的无关文件**

仓库根目录的 `1.md`（超级马里奥主题路线图）不属于本次改动，提交前请确认是否要一并提交或加入 `.gitignore`。

### P2 — 值得做，但不紧急

**3. `AgentSessionApp.tsx` 仍有 1995 行**

再往下拆要小心，容易把 React 状态切碎、反而增加耦合。当前内部结构：

| 区块 | 行号 | 行数 |
|---|---|---|
| 导入 + 常量 | 1–140 | 140 |
| 组件签名 + 布局/终端 | 141–157 | 17 |
| LLM / goal / vision 配置 | 158–178 | 21 |
| 后台任务管理器 | 179–237 | 59 |
| subagent 工具工厂 | 238–328 | 91 |
| todos 执行器 | 329–344 | 16 |
| reducer + goal 计时 | 345–450 | 106 |
| 输入 store / 权限 / 流缓冲 | 451–575 | 125 |
| session manager + goal session | 576–628 | 53 |
| 会话恢复（委托） | 629–736 | 108 |
| MCP 状态 | 737–818 | 82 |
| autocomplete | 819–853 | 35 |
| 模型切换 + effort | 854–977 | 124 |
| 布局 hook | 978–998 | 21 |
| copy + 键盘 | 999–1179 | 181 |
| **`handleSubmit`** | **1180–1469** | **290** |
| 后台完成 / 唤醒 / 队列 effect | 1470–1639 | 170 |
| 流式 burst hook | 1640–1653 | 14 |
| viewport / 滚动 | 1654–1698 | 45 |
| snapshot effect | 1699–1721 | 23 |
| JSX | 1722–1996 | 275 |

**最值得动的是 `handleSubmit` 的 290 行**：其中约 207 行是 `/goal` 处理（注册目标、`--bg` 派发、kickoff prompt 递归、busy 队列分支）。这块可以整体移到 `session/goal-commands.ts`，`handleSubmit` 会降到约 80 行。

**4. `useSessionLayout` 有 4 个返回值没人用**

`promptWidth`、`promptRows`、`permissionRows`、`planApprovalRows` 都被算出来并返回，但 `AgentSessionApp` 从未读取（只有 `todoRows` / `showWelcome` / `pickerLayout` / `feedHeight` / `promptPlaceholder` 在用）。要么删掉返回值，要么说明为什么保留——目前是死代码。

**5. `SEND_NOW_WAIT_TOOLS` 导出后无外部使用者**

`turn-execution.ts` 里 `export` 了它，但除本文件外无人导入。可以去掉 `export`。

### P3 — 观察项

**6. 全量测试的沙箱失败会掩盖真实回归**

74 个 `EPERM` 失败是环境问题，但它们让「全量测试是否变红」这个信号失效。建议加一个只跑离线用例的脚本（例如 `npm run test:offline`，排除 `server*` / `web-ui*` / `skills` / `git-workflow`），CI 里跑这个，本地有网络时再跑全量。

**7. `handleSubmit` 依赖数组仍有可收敛空间**

现在是 19 项。其中 `state` / `llm` / `vision` 等是每次渲染都可能变化的对象，导致 `handleSubmit` 的 identity 实际上每次都在变（`useCallback` 收益有限）。已经用 `commandCascadeContextRef` 解决了一部分，但 `runSessionTurn` 的入参仍是逐个传对象。彻底做法是给 `runSessionTurn` 也传一个 ref 化的 context。

---

## 四、补充说明（我认为需要提醒的）

### 4.1 重构没有动这些，请不要误改

以下不变量在重构中**刻意保持原样**，后续修改时请一并维护：

- 命令分发**顺序**：`/model` 在 `/effort` 之前、`parsePlanTurnOverride` 在 `/profiles` 之前，顺序改变会导致行为变化（例如 `/plan` 会被 `/model` 抢先匹配）。
- `handleSubmit` 的 **busy 分流点**：`state.busy` 判断在 profile 表单处理**之前**，这是有意的——忙碌时输入框里的内容应当进队列，而不是被当作表单输入。
- `streamBuffer.finish(runId)` 必须在**每条退出路径**上执行，否则下一回合的流会串。
- 权限 turn 必须在 `finally` 里 `close()`。
- 没有 `writeStaticBurst` 时（测试直接渲染 `App`、alternate 布局），**任何行都不能从 frame 里切走**，否则已 seal 的历史会从屏幕上消失。
- 工作区路径解析必须继续拒绝：项目外路径、未注册的 worktree、symlink 逃逸。

### 4.2 关于「整体逻辑不要动」

这次重构的边界是：**函数体逐字搬运 + 只改引用写法**。具体来说：

- `command-cascade.ts` 的函数体是从原 `handleSubmit` 里**切片粘贴**的，唯一的文本改动是 `return;` → `return HANDLED;`（因为要区分「命令已处理」和「继续走 Agent 回合」）。
- `turn-execution.ts` 同理，只把两处提前 `return;` 改成 `return { ran: false, succeeded: false }`。
- 所有 `useEffect` 的依赖数组、执行时机、清理函数**未改动**。

因此如果你在 review 时看到某处「行为好像变了」，更可能是我在搬动时漏了某个依赖，而不是有意改动——请直接指出来。

### 4.3 一个已知的取舍

`command-cascade.ts` 的 `CommandCascadeContext` 有 51 个字段（`TurnExecutionContext` 有 42 个）。这看起来不优雅，但它是**刻意的**：这些字段原本是 `handleSubmit` 闭包捕获的外部变量，显式列出来反而让依赖关系可见。想减少字段数，正确做法是把它们按域分组（`refs` / `callbacks` / `io`），而不是合并成 `ctx: any`。

### 4.4 后续如果继续拆分，建议的顺序

1. `handleSubmit` 的 goal 分支 → `session/goal-commands.ts`（收益最大，风险最低）
2. JSX 子树 → `SessionChrome.tsx`（输入区 + 状态栏）、`SessionOverlays.tsx`
3. `AgentSessionApp` 的 refs 初始化 → `useSessionRefs()`（纯搬运）

不建议动 `useStreamBursts` —— 它是全项目最微妙的一段（seal 账本 + 重试去重 + resize 重印），改动收益低、回归成本高。

---

## 五、快速自检命令

```bash
# 类型
npx tsc --noEmit

# 未使用声明（只看本次改动文件）
npx tsc --noEmit --noUnusedLocals 2>&1 | grep -E "src/tui/(App|AgentSessionApp|session/|hooks/)"

# TUI 全量（离线可跑）
npx tsx --test --test-force-exit --test-timeout=120000 "test/tui-*.test.ts"

# 构建
npm run build

# 验证命令顺序未被改动
# 对比 git show HEAD:src/tui/App.tsx 与 src/tui/session/command-cascade.ts
# 中的 if (trimmed === "...") / parse*Command 出现顺序
```
