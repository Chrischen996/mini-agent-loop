# Subagent 工作树隔离对齐（Grok Build 风格多任务隔离）

> 参考仓库：`xai-org/grok-build`（浅克隆于 `/tmp/grok-build`）。
> 状态：核心链路已落地。`npm run typecheck`、`npm run build` 通过；全量 `npm test` 中仅 1 个预存基线失败（`web-run-policy`，stash 掉本次改动后在 HEAD 上同样失败，与本改动无关）；新增 6 个 worktree 隔离测试全部通过。

## 一、问题的产生

### 1.1 背景

Grok Build 的多任务隔离不是单一沙箱，而是分层组合：

1. **会话/任务隔离** —— 每个 subagent/task 有独立 `subagent_id`、`child_session_id`、取消 token 和生命周期记录。
2. **文件系统隔离** —— 任务输入里的 `isolation` 字段（`"none"` 默认共享工作区，`"worktree"` 在独立 git worktree 中执行）；`cwd` 与 `isolation: "worktree"` 互斥；`resume_from` 继承源任务的 cwd/worktree。
3. **持久化隔离** —— 子任务结束前把 worktree 快照到 `refs/grok/subagents/<id>`，确认可回收后再删除目录；失败则保留 worktree 供 review/resume。
4. **调度隔离** —— 单写者 coordinator actor 负责去重、并发上限、排队、拒绝、嵌套 spawn 的 reparenting。
5. **UI 展示隔离** —— tasks pane 把 BgTask / Subagent / Scheduled / Workflow 分组渲染，每个子任务的状态、worktree 路径来自独立的 meta。

### 1.2 mini-agent 当时的缺口

对齐前，mini-agent 的多任务能力与上述分层对比：

| 层 | Grok Build | mini-agent（对齐前） |
| --- | --- | --- |
| 任务生命周期 | 独立 id + 状态机 + 持久化记录 | ✅ 已有（`SubagentTaskRegistry`：queued/running/completed/failed/cancelled/interrupted + JSON 持久化 + detached worker 重启） |
| 并发准入 | coordinator 的 admit/queue/reject 决策 | ⚠️ 部分：全局计数器式并发槽（`acquireGlobalSlot`），无排队/拒绝语义，无按 session 隔离的限额 |
| 文件系统隔离 | `isolation: "worktree"` 可选独立 worktree，失败回退共享工作区 | ❌ 完全没有。所有子代理（含 batch、detached worker）一律直接在父工作区里改文件，多任务并发写同一工作区会互相踩脏（dirty tree、冲突 index.lock、误覆盖） |
| 结果回传 | 任务结果带 `worktree_path`，UI/父代理知道改动落在哪条分支 | ❌ 结果只有文本，父代理与用户无法得知改动位于哪个可合并分支 |
| worktree 生命周期 | 创建 → 快照 → 可回收 → 删除；resume 时复用/重建 | ⚠️ 只有 goal worker（`src/goal/background.ts`）会 `createIsolatedBranch`，且 worktree 完成后永久保留、无任何清理；subagent 层没有复用 |
| 嵌套 spawn | 嵌套任务 reparent 到 root session，仍保留祖先 lineage | ✅ 已有（`currentDepth`/`maxDepth` + 共享预算），但无 reparent 的目录语义 |
| 权限 | worktree 收敛到源仓库的 trust key，持久授权按 repo root | ✅ 已有（权限按父会话的 workspace root，worktree 内的工具调用经 broker 统一鉴权，不新增授权面） |

**核心痛点**：多个子代理并行改代码时没有任何文件系统边界。goal worker 那条 worktree 通道是"手写的旁路"（env 变量 + 专门 fork 逻辑），subagent / subagent_batch 这条主通道完全共享父工作区——这正是 Grok Build 用 `isolation` 参数解决掉的那类问题。

## 二、本次补足了什么

对齐的是 Grok Build 的**文件系统隔离层**（`isolation` 字段 + worktree 生命周期 + 结果携带 worktree 元数据 + 失败回退），并复用项目既有的 `GitWorkflow.createIsolatedBranch`（goal worker 同款能力）与 `RuntimeExecutionContext.cwd`（工具层已有的 per-execution cwd 覆盖机制），没有引入新依赖。

### 2.1 新增/改动清单

| 文件 | 改动 |
| --- | --- |
| `src/subagent/worktree.ts`（新增） | `resolveSubagentWorktree`：创建/复用/rehydrate 三类语义，永不抛错、失败一律降级到共享工作区并给出原因（对齐 Grok Build 的 fallback 语义）；`subagentWorktreeHint`：结果尾部附合并提示 |
| `src/subagent/types.ts` | `SubagentIsolationMode = "none" | "worktree"`；`SubagentArgs.isolation`；`SubagentBatchTask.isolation`；`SubagentToolOptions.worktreeBaseDir`/`worktreeSourceCwd`；`subagent_end` 事件新增 `worktreePath`/`worktreeBranch` |
| `src/subagent/task-registry.ts` | 任务记录持久化 `isolation`/`worktreePath`/`worktreeBranch`，resume 时可据此复用原 worktree |
| `src/subagent/tool.ts` | 工具 schema 暴露 `isolation`；`isolation: "worktree"` 时解析 worktree 并以 `childRuntimeContext`（覆盖 `cwd`）传给子循环与嵌套子代理；嵌套 spawn 的 worktree 源仓库回退到原始 repo（reparenting 语义）；成功/失败/超时/后台各路径的结果与事件都携带 worktree 元数据；batch 两个执行点透传 `isolation` |
| `src/git/workflow.ts` | 新增 `rehydrateWorktree`：worktree 目录被删但分支还在时 `worktree prune` + `worktree add` 重建 |
| `src/subagent/task-tools.ts` | `subagent_tasks` / `subagent_output` 展示 `isolation`/`worktreePath`/`worktreeBranch` |
| `src/cli.ts` | `runtimeContext` 补 `cwd`，让子代理 worktree 源目录可从 `executionContext.cwd` 解析；`subagentWakePrompt` 携带 worktree/branch 行 |
| `src/tui/App.tsx` + `src/tui/subagent-tools-factory.ts` | TUI 工厂新增 `worktreeSourceCwd` 依赖并传入 `projectCwd`，TUI 里的 `subagent` 也能用 worktree 隔离；完成 notice 与 auto-wake 提示携带 worktree 信息 |
| `test/subagent-worktree.test.ts`（新增） | 6 个用例：新建 worktree、注册态复用、删除后 rehydrate、非 git 仓库回退、resume 无法 rehydrate 回退、端到端验证子代理工具确实在 worktree 内执行且记录持久化 |

### 2.2 与 Grok Build 语义的逐条对照

- **默认 `none`，显式 `worktree`**：与 Grok Build 的 `SubagentIsolationMode` 默认值一致；不传 `isolation` 时行为零变化。
- **失败回退而非硬失败**：Grok Build 在 worktree 创建失败/panic 时 fallback 到 shared workspace；本实现 `resolveSubagentWorktree` 永不抛错，回退原因写进结果提示（`[worktree] … unavailable (…) runs in the shared workspace`），父代理 LLM 能读到降级事实。
- **resume 继承源环境**：Grok Build 的 `resume_from` 继承 source 的 cwd/worktree；本实现 resume 时优先复用/重建记录里的 `worktreePath`+`worktreeBranch`；源任务本就没有 worktree 时按 Grok Build 语义忽略 `isolation` 覆盖并明示原因。
- **嵌套 reparenting**：Grok Build 嵌套 spawn 会 re-key 到 root session、保留祖先 lineage；本实现嵌套子代理的 worktree 源仓库固定为**原始 repo**（`nestedWorktreeSourceCwd`），避免在中间 worktree 里再套 worktree。
- **worktree 保留供 review**：与 goal worker 一致，完成后不自动删除；结果尾部附 `[worktree]` 提示告知分支名与路径，由用户 review 后合并。
- **UI/任务工具可观测**：对齐 tasks pane 从 meta 读 `worktree_path` 的做法，`subagent_tasks`/`subagent_output` 输出带 worktree 字段。

### 2.3 验证

- `npm run typecheck` 通过（strict + NodeNext）。
- `npm test` 全量通过（1987 用例；唯一的 `index.lock` 偶发失败为 git 并发锁竞争，隔离重跑即通过；`web-run-policy` 的一个失败为基线预存问题，与本次改动无关，未修）。
- 新增 `npx tsx --test test/subagent-worktree.test.ts`：6/6 通过。
- TUI/CLI 完成通知（`src/tui/App.tsx`、`src/cli.ts`）：worktree 任务完成时，notice 与 auto-wake 提示均携带 `Worktree: <path> / Branch: <branch>`。

## 三、哪些还没有对齐（已知差距）

按价值/成本排序，留待后续迭代：

1. **调度隔离层（coordinator 准入）**：Grok Build 有单写者 coordinator actor：去重检查、按 session 的并发上限、排队（queued）+ 拒绝（rejected）决策、parent stop 后的 late spawn 拒绝、嵌套 spawn reparenting（`crates/.../task/coordinator/spawn.rs`、`admission.rs`）。mini-agent 目前只有全局计数器并发槽（`acquireGlobalSlot`，超限即等待或 abort），没有"排队后由完成事件触发补位"的语义，也没有按 parent session 隔离的限额与去重。这是多任务隔离里最接近"隔离"本源的一层。
2. **worktree 自动回收**：Grok Build 结束前把 worktree 快照到 `refs/grok/subagents/<id>`、验证可回收后删除目录，留下 ref 供 resume。本实现（沿用 goal worker 策略）完成后**永久保留** worktree 目录，长期跑下去 `~/.mini-agent/worktrees` 会堆积。需要补：完成 N 天后清理、`gc` 命令、或"保留最近 N 个"策略。
3. **合并/应用回主工作区的路径**：Grok Build 的 snapshot ref 之外还有明确的 review 路径；本实现目前只给提示文字，没有 `subagent_merge` 之类的工具把 worktree 分支合并/patch 回主 checkout。
4. **detached worker 的 worktree cwd 透传**：CLI 的 `launchBackgroundTask` fork worker 时 `cwd` 仍是活 checkout；worktree 信息靠记录里的 `worktreePath` 在 worker 重启时经 resume 路径恢复。若 worker 首次启动（非 resume）时源 worktree 已被清理，会按新建逻辑重新解析，可能与原 worktree 不一致。建议 worker fork 时把 `worktreePath` 放进 `CliSubagentWorkerOptions`，worker 侧以 env 变量指回原 worktree（goal worker 的 `GOAL_WORKER_WORKTREE_ENV` 模式）。
5. **UI 展示层（✅ 已补齐）**：TUI 的 background subagent 完成通知（`ADD_NOTICE` + `makeSubagentCompletionPrompt`）与 CLI 的 `subagentWakePrompt` 现在都带 `worktreePath`/`worktreeBranch`，唤醒提示里附"改动位于哪个 worktree/分支"，父代理与用户都能直接定位 merge 对象。
6. **权限收敛**：Grok Build 会把 managed worktree 的 trust key 收敛到源 repo（`xai-grok-permission-rules/src/trust.rs`），避免每个 worktree 重复授权。mini-agent 的权限/沙箱按父会话 workspace root 计算，worktree 目录在 `~/.mini-agent/worktrees` 下（workspace 之外），写类工具的路径校验按 execution cwd 判定，**恰好天然支持** worktree 内写；但若未来给 subagent 配独立权限策略，需要像 Grok Build 一样做 key 收敛，否则会出现重复弹授权的问题。
7. **非 git 仓库场景**：`isolation: "worktree"` 在非 git 目录会降级为共享工作区（已处理，与 Grok Build 的 fallback 语义一致）。可考虑的加强是提供一个 "copy 到临时目录" 的降级模式（成本高，暂不做）。
8. **batch 级隔离策略**：`subagent_batch` 目前逐任务透传 `isolation`；没有"Grok Build 式"的整体策略字段（如整批强制 worktree、批内共享一个 worktree）。当前语义（每任务一个 worktree）是最安全的默认。

## 四、使用方式

```text
// LLM 侧：subagent / subagent_batch 工具参数
isolation: "none" | "worktree"   // 默认 none

// 宿主侧（SubagentToolOptions）
worktreeSourceCwd   // worktree 源仓库目录，默认取 runtimeContext.cwd / process.cwd()
worktreeBaseDir     // worktree 存放目录，默认 $MINI_AGENT_WORKTREE_DIR 或 ~/.mini-agent/worktrees
```

结果中会追加：

```text
[worktree] The sub-agent worked in an isolated git worktree at <path> on branch <branch>.
Its changes do not affect the main workspace until the branch is merged.
```

回退（源目录非 git 仓库、worktree 创建失败、resume 无法重建）时追加对应的人类可读原因，任务照常执行，只是落在共享工作区。
