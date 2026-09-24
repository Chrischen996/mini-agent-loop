# /multi-agent 角色模型配置 + H3/H4 引擎 · 开发文档（完成版）

> 历史实现记录：下文提及的 `terminal-main.ts` / `main.ts` 终端入口已移除，
> 当前唯一的交互式终端为 `src/tui/ink-main.tsx` + `App.tsx`（Ink）。

> 更新日期：2026-09-18
> 范围：`/multi-agent` 向导内子角色模型配置（角色矩阵 + 新建模型子流程）、H3 多步规划 / H4 自我反思引擎及其与 TUI 的完整接线、三端（App.tsx / terminal-main.ts / main.ts）运行时的 `roleLlmConfigs` 注入一致性，以及代码评审后的 P1/P2 缺陷修复。
> 参考设计：`docs/multi-agent-orchestration-design.md` §4/§6/§7，`docs/superpowers/specs/2026-09-17-multi-agent-role-model-setup-design.md`

---

## 1. 总览

| 能力 | 状态 | 位置 |
|---|---|---|
| `/multi-agent` 四步向导（model → mode → roles → task） | ✅ 完成 | `src/tui/App.tsx`（Ink）、`src/tui/terminal-main.ts`（ANSI） |
| 角色矩阵：inherit / 已有 profile / 新建模型 | ✅ 完成 | 同上 + `terminal-autocomplete-controller.ts`、`terminal-overlay-lines.ts` |
| 角色绑定持久化到 `~/.mini-agent/models.json` | ✅ 完成 | `src/profile-store.ts`（`saveSubagentRole` / `subagentRoles`） |
| 三端运行时 `roleLlmConfigs` 注入 | ✅ 完成 | `App.tsx` / `terminal-main.ts` / `main.ts` + `subagent-tools-factory.ts` 缓存修复 |
| H3 规划引擎（需求 → TaskSpec[] → DAG 批次 → 派发） | ✅ 完成 | `orchestration/pipeline/{splitter,orchestrator,planning-engine}.ts` |
| H4 验收引擎（五道门禁 + maxIter 闭环） | ✅ 完成 | `orchestration/pipeline/orchestrator.ts` + `review-engine.ts` |
| `planner_worker_reviewer` 模式真正驱动 H3/H4 | ✅ 完成 | `multi_agent_pipeline` 工具（App.tsx / terminal-main.ts 提交路径） |
| P1：roleLlmConfigs 统一传入 pipeline orchestrator（H3/H4 子代理角色绑定生效） | ✅ 完成 | `PipelineOrchestratorOptions.roleLlmConfigs` + `createAnalyzePipelineTool` |
| P1：terminal 新建模型后 roleSetup 状态保存 | ✅ 完成 | `terminal-autocomplete-controller.ts` `openModelSetup` |
| P1：Ink 模型切换时序修复（orchestrator model 未应用到本 turn） | ✅ 完成 | `App.tsx` `switchLlmModel` 同步生效 |
| P1：H4 review 统一 + reviewer verdict 语义修正 | ✅ 完成 | `orchestrator.ts` 内置 `review()` + `review-engine.ts` 一致 |
| P1：取消 / 队列 / 失败回滚 / 缓存比较 | ✅ 完成 | `RunOptions.signal`、per-run checkpoint、factory cache 修复 |
| 引擎离线测试 | ✅ 完成 | `test/pipeline-engines.test.ts`（12 用例）+ `test/multi-agent-role-integration.test.ts`（2 用例） |

---

## 2. 数据流

```
/multi-agent
  Step A: 选 Orchestrator 模型
  Step B: 选执行模式（planner_worker_reviewer / agent_turn）
  Step C: 角色矩阵（researcher / coder / reviewer）
           ┌ inherit ─────────────┐
           ├ 已有 profile ────────┤ → saveSubagentRole(role, name)
           └ draft-new → role-new ┤ → saveProfile + saveSubagentRole
  Step D: 任务描述 → 启动

运行时（App.tsx / terminal-main.ts / main.ts 三端一致）：
  loadProfileStoreSync()
    → resolveSubagentRoleLlmConfigs(store)
    → switchLlmModel(parentLlm, profile.model, { baseUrl, apiKey })
  SubagentToolsFactory.getTools({ parentLlm, roleLlmConfigs })
  派发优先级：args.model > profile.llm > roleLlmConfigs[role] > parentLlm

planner_worker_reviewer 模式（本次接通 + P1 修复）：
  提交任务时额外注入 multi_agent_pipeline 工具
    → LLM 调用该工具(requirement)
    → analyzeRequirement（H3 拆解，researcher 子代理 + 自检重试）
    → topologicalBatches（DAG 环检测，§4.5）
    → PipelineOrchestrator.run（批次串行 / 批内并行，§4.7 文件所有权）
      → 每个 spec：dispatch（coder 子代理）→ 五道门禁验收 → maxIter 迭代闭环
      → roleLlmConfigs 注入到 PipelineOrchestrator（P1 修复）：
        researcher / coder / reviewer 三个角色子代理均按角色绑定解析 LlmConfig
    → 返回结构化 JSON 汇总（merged / escalated 每个任务的裁决）
  取消 / 回滚语义（P1 修复）：
    → RunOptions.signal 支持 per-run 取消（覆盖构造函数 signal）
    → 每个 spec 派发前自动 captureCheckpoint，review 通过后刷新
    → 失败/取消时 checkpoint 可用于回滚到派发前状态
  缓存比较修复（P1）：
    → SubagentToolsFactory.getTools 改为比较 model + roleLlmConfigs 全量内容
      （JSON.stringify），同一角色换绑不同 endpoint 后工具必然重建
```

---

## 3. 各模块详情

### 3.1 状态类型（`src/tui/types.ts`）
- `MultiAgentRoleName` = `researcher | coder | reviewer`
- `MultiAgentRoleAssignment` = `inherit` / `profile{profileName}` / `draft-new{modelId, baseUrl?, apiKey?}`
- `MultiAgentSetupState.step` = `"model" | "mode" | "roles" | "role-new" | "task"`，含 `roleAssignments`、`roleIndex`
- `RoleSetupState.pendingNewModelRoleIndex`：角色向导 → 新建模型子流程的跨步骤传参

### 3.2 缓存修复（`src/tui/subagent-tools-factory.ts`）
`getTools` 原来只比较 `Object.keys(roleLlmConfigs)`；现在同时比较全量内容
（`JSON.stringify`），同一角色换绑不同 endpoint 后工具必然重建。

### 3.3 App.tsx（Ink/React 端）
- 向导状态机：`multi-agent-model → multi-agent-mode → multi-agent-roles →
  multi-agent-role-new（可选）→ multi-agent-task`
- 选 `n+1`（新建模型）进入 `role-new` 后**立即 return**，避免被下方
  "推进到下一角色" 逻辑覆盖（本次修复的真实 bug）
- 提交任务前把 `roleAssignments` 落盘：`inherit` → `saveSubagentRole(role, null)`；
  `profile` → `saveSubagentRole(role, name)`；`draft-new` →
  `saveProfile(name, model+url+key)` + `saveSubagentRole`（`saveProfile` 本身
  已 `load → upsert → save`，不再重复写盘，本次修复）
- **运行时注入**：`getSubagentTools` 每次调用解析 `loadProfileStoreSync()` →
  `resolveSubagentRoleLlmConfigs` → `switchLlmModel`，把各角色 `LlmConfig`
  传给工厂。此前 Ink 端配完角色模型后子代理运行时仍全部走 `parentLlm`
- **`planner_worker_reviewer` 接线**（本次新增）：该模式下提交任务前动态
  `import("../orchestration/pipeline/planning-engine.ts")` 构造
  `createAnalyzePipelineTool`，注入本 turn 的工具集，LLM 可调用
  `multi_agent_pipeline` 驱动完整 H3+H4 流水线；`agent_turn` 模式保持原有
  纯 subagent 委托行为

### 3.4 terminal 端（独立 ANSI 渲染器）
- `/multi-agent [task]`：
  - 有内联任务 → 跳过向导，直接进入 pipeline 提交路径
  - 无任务 → 提示并打开角色向导，置位 `multiAgentTaskPendingRef`；
    之后的第一条普通文本输入被识别为任务描述，走 pipeline 提交路径
- 角色向导 `submitRoleSetup`：`0 = inherit`、`1..n = 已有 profile`、
  `n+1 = 新建模型`（打开 `model-setup`，保存 profile 后按
  `pendingNewModelRoleIndex` 自动绑回当前角色并继续向导）
- 向导完成后提示输入任务描述
- **`planner_worker_reviewer` 接线**（本次新增）：`submitMultiAgentTask`
  在提交前把 `createAnalyzePipelineTool` 实例放进
  `multiAgentPipelineToolRef`，该 ref 同时挂到 `parentTools` 工具集上，
  turn 结束后移除
- 运行时 `buildRoleLlmConfigs()`（`terminal-main.ts` / `main.ts` 原本已有）
  与 App.tsx 语义一致

### 3.5 H3 多步规划引擎
- `orchestrator.ts`（内核，原有 + P1 修复）：`topologicalBatches`（§4.5）、
  `enforceFileOwnership`（§4.7）、`PipelineOrchestrator.run`（§7 闭环）、
  五道门禁的内置 `review()`；`externalReviewer` 选项允许替换 gate 4
  - **P1：`roleLlmConfigs` 注入**：`PipelineOrchestratorOptions.roleLlmConfigs`
    传入共享的 `createSubagentTool`，使 H3 researcher 拆解和 H4 worker/reviewer
    派发均按 `/multi-agent` 角色绑定解析 LlmConfig（优先级
    `args.model > profile.llm > roleLlmConfigs[role] > parentLlm` 不变）
  - **P1：per-run 取消**：`RunOptions.signal` 覆盖构造函数 `options.signal`；
    存储在 `private runSignal`，所有 dispatch/reviewer/checkpoint/validate
    调用点均用 `this.runSignal ?? this.options.signal`；批间检查
    `runSignal?.aborted` → 剩余 specs 标记为 `blocked`
  - **P1：pre-task checkpoint**：`processTask` 在首次派发前捕获
    `git_checkpoint`（若 `captureCheckpoint !== false`），review 通过后刷新；
    支持 §7.1 回滚语义
  - **P1：reviewer verdict 契约**：`externalReviewer` 抛异常 → 转换为 failed
    verdict `"external reviewer failed: …"`；`passed:false` 且
    `failed_items` 为空 → 归一化为通用 failed item；最终
    `passed = reviewerVerdict.passed && failed_items.length === 0`
- `splitter.ts`（M2，原有 + P1）：`analyzeRequirement` 跑 researcher 子代理 +
  自检重试（maxResplitRounds 默认 2）；`SplitOptions.roleLlmConfigs` 支持
  researcher 角色绑定
- `planning-engine.ts`（本次完善 + P1）：
  - `analyzeAndRunPipeline(requirement, options)`：端到端
    拆解 → 拓扑校验 → `PipelineOrchestrator.run`，返回
    `{ specs, batches, summary }`。`options.split` 现在可选，缺省时自动从
    外层 options 继承 `parentLlm` / `parentTools` / `chat` / `roleLlmConfigs`
  - `createAnalyzePipelineTool(options)`：把整条流水线暴露成
    `multi_agent_pipeline` 工具（LLM 直接调 `requirement` 入参），返回
    结构化 JSON 汇总（ok / 各任务 status / verdict / attempts / checkpoint）
  - **P1：AbortSignal 转发**：`execute(args, signal)` 把 tool-call 的
    `AbortSignal`（来自 loop broker）转发进 `analyzeRequirement` +
    `orchestrator.run`；中途取消返回 `{ok:false, aborted:true, …}` 且
    `isError:true`

### 3.6 H4 验收引擎
- `orchestrator.ts` 内置五道门禁：
  worker 状态 / 文件范围（含存在性检查）/ validate（`validate_workspace`
  工具自动发现，缺失则 skip）/ import 安全（opt-in）/ 独立 reviewer 子代理
  - **P1：reviewer verdict 契约统一**：内置 `review()` 与
    `review-engine.ts` 的 `reviewAndMerge` 现在遵循相同的硬门禁跳过语义
    （`undefined` = 跳过 = 不阻断）和相同的
    `passed = reviewerVerdict.passed && failed_items.length === 0` 规则；
    内置路径额外强制执行文件存在性检查
  - **P1：`externalReviewer` 异常处理**：外部 reviewer 抛异常不再打断
    整个流水线，而是转换为 failed verdict
    `"external reviewer failed: …"`；`passed:false` 且
    `failed_items` 为空的异常 verdict 会被归一化为通用 failed item
    `"reviewer reported failure (no details)"`
- `review-engine.ts`（独立模块，本次语义修正 + P1 统一）：
  - `reviewAndMerge(result, spec, reviewerVerdict, options, iter, maxIter)`
  - **硬门禁语义修正**：`hardGates` 改为 `{ test?: boolean; typecheck?: boolean;
    build?: boolean }` —— 只有 `runValidation` 实际跑过且失败的脚本才是
    `false`；workspace 没配置某脚本时对应 gate 保持 `undefined`（跳过），
    不再因「三项必须全 true」导致缺脚本的仓库必然验收失败
  - 失败且未达 `maxIter` 时返回 `revisedSpec`（修复项追加到 `acceptance`）
  - 接入方式：通过 orchestrator 的 `externalReviewer` 选项，或直接调用
    （orchestrator 默认仍走内置 `review()`，`reviewAndMerge` 是外部裁决的
    可选实现；两条路径现在遵循统一的 verdict 语义）

### 3.7 测试
- `test/pipeline-engines.test.ts`（12 用例）：
  - `reviewAndMerge`：全绿通过 / 状态门 / 文件范围门 / 语义门 / 迭代耗尽不
    再出修订 spec
  - `analyzeAndRunPipeline`：faux chat 离线跑通完整流水线
  - `multi_agent_pipeline` 工具：结构化 JSON 结果
  - `externalReviewer`：确认替换内置 reviewer
  - **P1 新增 4 用例**：
    - `passed:false` + 空 `failed_items` → 归一化为含 ≥1 条 failed item 的失败裁决
    - 外部 reviewer 抛异常 → 转换为含 `"external reviewer failed: …"` 的失败裁决
    - per-run `RunOptions.signal` 中断在途 dispatch（无 `done` 条目，
      `controller.signal.aborted === true`）
    - pre-dispatch checkpoint：父工具集无 `git_checkpoint` 时
      `entry.checkpoint === undefined`（流水线仍正常通过）
- `test/multi-agent-role-integration.test.ts`（2 用例）：
  - `subagentRoles` 绑定后 `resolveSubagentRoleLlmConfigs` 正确解析
  - `SubagentToolsFactory` 在 `roleLlmConfigs` 内容变化时重建工具

---

## 4. 验证结果

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | ✅ 本次改动零新增错误（仓库中仅 1 个与本任务无关的既有错误：`src/mcp/client.ts(142,23)`） |
| `npm test` | ✅ 1319 pass / 0 fail（含 P1 新增 4 个 pipeline-engines 用例，总计 1319） |
| `npm run build` | ✅ 构建成功，`planning-engine` 独立 chunk 已产出 |
| 真实模型端到端（coder 请求打到绑定 endpoint） | ⚠️ 离线测试不覆盖，需 API key 实跑 |

---

## 5. 已知限制 / 后续

1. **terminal 向导是「轻量版」**：相比 App.tsx 的完整四步状态机，terminal
   端把「选模式」一步省略了（固定走 `planner_worker_reviewer` 提交路径），
   角色矩阵通过既有 role-setup overlay 完成。如需 terminal 端也提供
   `agent_turn` 选项，需要扩展 `AcMode` 状态机。
2. **`multi_agent_pipeline` 是 LLM 驱动而非代码强制**：主 agent 拿到工具后
   仍需要自己决定调用；prompt 里注入了 `Multi-agent mode:
   planner_worker_reviewer` 标签引导。若要求 100% 确定性，可以在
   `planner_worker_reviewer` 模式下直接调用 `analyzeAndRunPipeline` 而不
   经过 LLM 决策（会失去 LLM 对拆分的动态调整能力）。
3. **`reviewAndMerge` 与内置 `review()` 是两条验收路径**：内置路径用于
   orchestrator 主闭环（带文件存在性检查），`reviewAndMerge` 用于外部
   verdict 接入（不做文件存在性检查，仅做 `files_hint` 范围 + 硬门禁 +
   语义验收）。两条路径现在遵循统一的 verdict 语义（`undefined` 硬门禁
   = 跳过，`passed = reviewerVerdict.passed && failed_items.length === 0`），
   选用时注意内置路径多一步文件存在性检查。
4. **未做真实请求验收**：角色模型绑定是否真的让 coder 子代理打到指定
   endpoint，需要 API key 环境验证。
5. `TaskSpec` DAG 在 plan 审批 UI 中的可视化未做（设计稿 §4.5 的可读性
   增强，不影响功能）。
