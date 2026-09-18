# `/multi-agent` 角色模型配置向导 · 开发文档

> 状态：设计稿（仅文档，不改代码）  
> 日期：2026-09-17  
> 范围：MVP — 在 `/multi-agent` 流程内为子角色指定模型，必要时录入 `baseUrl` + `apiKey`  
> 非目标：本次不实现代码；不重构 orchestration 内核；不引入跨进程 worker

---

## 1. 背景与问题

### 1.1 现状

当前 `/multi-agent` 交互向导只收集：

1. Orchestrator 模型 ID
2. 执行模式（`planner_worker_reviewer` / `agent_turn`）
3. 任务描述

子 Agent（`researcher` / `coder` / `reviewer`）的模型来源是另一条链路：

- 内置 profile 只定义**能力与工具集**（系统提示、允许工具、maxTurns），不定义独立 LLM 凭证
- 角色 → 模型绑定依赖 `~/.mini-agent/models.json` 中的 `subagentRoles`
- 绑定 UI 挂在「主模型切换后的 role-setup 向导」，**不在** `/multi-agent` 流程内
- 若未绑定，子 Agent 继承主会话 `parentLlm`（同一 `model` / `baseUrl` / `apiKey`）

相关实现锚点：

| 能力 | 位置 |
|------|------|
| `/multi-agent` 向导状态 | `src/tui/types.ts` → `MultiAgentSetupState` |
| `/multi-agent` 提交流程 | `src/tui/App.tsx`（及 terminal 入口对等逻辑） |
| 角色绑定向导 | `src/tui/terminal-main.ts` → `openRoleSetupWizard` / `submitRoleSetup` |
| Profile 持久化 | `src/profile-store.ts` → `ModelProfile` / `subagentRoles` |
| 子 Agent 模型解析 | `src/subagent/tool.ts` → `roleLlmConfigs` 优先级 |
| 运行时注入角色 LLM | `src/tui/terminal-main.ts` / `src/tui/main.ts` → `buildRoleLlmConfigs` |

### 1.2 用户诉求

进入 `/multi-agent` 后，用户希望：

1. 明确看到并配置各个子角色
2. 为每个角色选择（或指定）模型
3. 若模型尚未配置，直接填入 `url` 与 `key`
4. 配完再进入任务，而不是事后到别的入口补配置

### 1.3 问题本质

不是「子 Agent 不能换模型」，而是：

- **配置入口与启动入口分离**
- **角色存在，但启动时不强制/不引导完成模型指派**
- 用户无法在 multi-agent 心智下完成「主模型 + 子模型矩阵」的一次性准备

---

## 2. 目标与非目标

### 2.1 目标（MVP）

1. 扩展 `/multi-agent` 向导，在启动任务前完成子角色模型配置。
2. 每个角色支持：
   - 继承主模型（Orchestrator / 当前会话 LLM）
   - 选择已有 model profile
   - 新建：`modelId + baseUrl + apiKey`，并保存为 profile 后绑定
3. 配置结果能进入本次 multi-agent 运行时的 `roleLlmConfigs`。
4. 尽量复用现有 `/model` setup、`profile-store`、`role-setup` 能力，避免第二套凭证体系。
5. 保持子 Agent 请求优先级不变：

```text
args.model
  > profile.llm
  > roleLlmConfigs[role]
  > parentLlm
```

### 2.2 非目标（MVP 明确不做）

- 不改 subagent 执行内核协议
- 不实现跨机器 / 外部队列 worker
- 不在本次文档落地阶段改代码
- 不强制用户每次手填 url/key（有 profile 可直接选）
- 不新增无限自定义角色（仍固定 `researcher` / `coder` / `reviewer`）
- 不在 MVP 做复杂的「每次任务独立凭证保险库」
- 不保证深度 `development_pipeline` 路径与 UI 向导 100% 行为对齐（见 §8 风险，列为 follow-up）

### 2.3 成功标准

- 用户仅通过 `/multi-agent` 一条路径，即可为 coder 指定与主模型不同的 endpoint/key，并成功发出子 Agent 请求。
- 未配置的角色默认继承主模型，行为与今天一致（向后兼容）。
- 新建的 url/key 进入 profile store，后续可被 role-setup / multi-agent 复用。
- App（Ink）与 terminal 两套 TUI 入口行为一致，或明确以 terminal 为先、App 跟随（见 §6 分期）。

---

## 3. 设计原则

1. **启动入口合并，存储模型复用**  
   UI 进 multi-agent；数据仍走 `ModelProfile` + `subagentRoles`。
2. **默认安全、少打扰**  
   默认「继承主模型」，一键跳过；需要差异化时再展开。
3. **凭证不进会话 transcript**  
   apiKey 只进 profile store / 运行时 `LlmConfig`，不写到用户消息、notice 明文、日志。
4. **一次配置，两条消费路径可演进**  
   MVP 先打通 `agent_turn` + 普通 `subagent`/`subagent_batch`；pipeline 对齐作为明确 follow-up。
5. **最小状态机扩展**  
   在现有 `MultiAgentSetupState` 上增加步骤，不新造平行向导框架。

---

## 4. 用户流程（目标体验）

### 4.1 主路径

```text
/multi-agent
  │
  ├─ Step A: Orchestrator 模型
  │     Enter = 当前模型
  │     或输入 model id
  │
  ├─ Step B: 模式
  │     1) planner_worker_reviewer
  │     2) agent_turn
  │
  ├─ Step C: 子角色模型矩阵（新增）
  │     依次或总览配置：
  │       researcher
  │       coder
  │       reviewer
  │     每角色选项：
  │       0) 继承主模型
  │       1..n) 已有 profile
  │       n+1) 新建模型（model → baseUrl → apiKey）
  │
  ├─ Step D: 持久化策略（MVP 简化，见 4.3）
  │
  └─ Step E: 任务描述 → 启动
```

### 4.2 快捷路径

```text
/multi-agent 修复登录超时
```

- 预填任务
- Orchestrator = 当前模型
- mode = `planner_worker_reviewer`
- **仍进入 Step C**（角色模型确认），避免“带任务启动却静默继承”的惊喜
- 提供「全部继承并直接开始」快捷确认，降低摩擦

### 4.3 持久化策略（MVP 决策）

MVP 采用：

> **配置写入全局 `subagentRoles`（保存为默认）**

理由：

- 与现有 `role-setup` 完全同构，实现量最小
- 用户二次进入 multi-agent 可直接复用
- 「仅本次」需要会话级 override 通道，留到 v1.1

文档中把「仅本次 / 保存为默认」双模式列为 **v1.1**，避免 MVP 同时改持久化语义与向导。

> 若产品坚持 MVP 就上双模式，见 §11 备选；默认方案仍是“保存为默认”。

### 4.4 单角色「新建模型」子流程

复用现有 model-setup 交互：

```text
选择「新建」
  → 输入 model id（如 openai/gpt-4o-mini）
  → 输入 baseUrl
  → 输入 apiKey（mask）
  → validate / 保存 profile
  → 绑定到当前角色
  → 下一个角色
```

Profile 命名建议（与现有 switch 后自动保存风格一致）：

```text
${provider}-${model}` 规范化，冲突则后缀 `-ma-${role}` 或短 hash
```

### 4.5 取消与回退

| 操作 | 行为 |
|------|------|
| Esc 在角色步骤 | 取消整个 multi-agent 向导，不启动任务；已写入的 profile 若已 save 则保留（凭证不应因取消而丢失） |
| Esc 在新建 url/key 子步骤 | 回到该角色选择列表，不绑定 |
| 全部角色选继承 | 合法；等价今天行为 |
| 中途切会话/Ctrl-C | 向导状态丢弃；已 save 的 profile/roles 以落盘为准 |

---

## 5. 信息架构与状态模型

### 5.1 扩展 `MultiAgentSetupState`

现有：

```ts
type MultiAgentSetupState = {
  step: "model" | "mode" | "task";
  orchestratorModel?: string;
  mode?: "planner_worker_reviewer" | "agent_turn";
  task?: string;
};
```

目标：

```ts
type MultiAgentRoleName = "researcher" | "coder" | "reviewer";

type MultiAgentRoleAssignment =
  | { type: "inherit" }
  | { type: "profile"; profileName: string }
  | {
      type: "draft-new";
      modelId: string;
      baseUrl?: string;
      apiKey?: string;
      field?: "modelId" | "baseUrl" | "apiKey";
      error?: string;
    };

type MultiAgentSetupState = {
  step:
    | "model"
    | "mode"
    | "roles"          // 角色矩阵（总览或逐角色）
    | "role-new"       // 新建模型子流程
    | "task";
  orchestratorModel?: string;
  mode?: "planner_worker_reviewer" | "agent_turn";
  /** 当前正在配置的角色下标；roles 步骤使用 */
  roleIndex?: number;
  /** 三个角色的选择结果 */
  roleAssignments?: Record<MultiAgentRoleName, MultiAgentRoleAssignment>;
  /** role-new 时的草稿（也可内嵌在 assignment.draft-new） */
  task?: string;
};
```

### 5.2 与 `RoleSetupState` 的关系

| | `RoleSetupState` | `MultiAgentSetupState.roles` |
|--|--|--|
| 触发 | 主模型切换后 | `/multi-agent` |
| 选项 | 继承 / 已有 profile | 继承 / 已有 profile / **新建** |
| 持久化 | `setSubagentRole` | 同左（MVP） |
| 去留 | **保留** | 新增；可共享提交 helper |

MVP 不删除主模型切换后的 role-setup，避免回归。  
中期可抽 `submitRoleBinding(role, profileName | null)` 共用。

### 5.3 运行时配置组装

启动任务前：

```text
1. 若 orchestratorModel != current → switch 主模型
2. 对 roleAssignments:
     inherit     → setSubagentRole(role, null) 或跳过
     profile     → setSubagentRole(role, name)
     draft-new   → saveProfile(...) → setSubagentRole(role, newName)
3. buildRoleLlmConfigs(parentLlm)
4. runAgentTurn(..., tools: getSubagentTools(llm with roleLlmConfigs))
```

关键点：`getSubagentTools` / `SubagentToolsFactory` 必须在角色绑定保存后重建，避免吃到旧的 `roleLlmConfigs` 缓存。

现有 factory 只浅比较 `Object.keys(roleLlmConfigs)`，**不足以**感知同 key 不同 endpoint 的变化。  
MVP 实现时需补强依赖比较（例如 parent model + role config fingerprint），文档要求写入实现计划。

### 5.4 数据落盘形态

`~/.mini-agent/models.json`（示意）：

```json
{
  "version": 1,
  "active": "claude-main",
  "profiles": {
    "claude-main": {
      "model": "anthropic/claude-sonnet-4",
      "baseUrl": "https://api.anthropic.com",
      "apiKey": "..."
    },
    "cheap-coder": {
      "model": "deepseek/deepseek-chat",
      "baseUrl": "https://api.deepseek.com",
      "apiKey": "..."
    }
  },
  "subagentRoles": {
    "coder": "cheap-coder",
    "reviewer": "claude-main"
  }
}
```

未出现的角色 = 继承主模型。

---

## 6. 分层设计

### 6.1 UI 层（TUI）

涉及文件（实现阶段）：

- `src/tui/types.ts` — 状态类型
- `src/tui/App.tsx` — Ink 向导分支
- `src/tui/terminal-main.ts` — terminal 向导分支
- `src/tui/input-utils.ts` — `AcMode` 增加 multi-agent 角色相关 mode
- `src/tui/terminal-autocomplete-controller.ts` / overlay 展示
- `src/tui/slash-commands.ts` — 帮助文案更新
- 可选：抽出 `src/tui/multi-agent-wizard.ts` 避免 App/terminal 双份逻辑漂移

**分期建议**

| 阶段 | 范围 |
|------|------|
| MVP-a | terminal-main 完整向导 |
| MVP-b | App.tsx 对齐 |
| v1.1 | 抽取共享 wizard module |

若资源只够一端，**优先 terminal-main**（当前 role-setup 完整逻辑已在此），App 显示“请使用 terminal 完成角色配置”为不可接受降级；应对齐，至少达到相同 step。

### 6.2 配置层（Profile Store）

复用：

- `saveProfile`
- `setSubagentRole` / `saveSubagentRole`
- `resolveSubagentRoleLlmConfigs`
- `listProfiles`

可能小扩展（实现阶段评估）：

- `ensureProfile(name, profile)` 统一命名冲突
- `buildRoleLlmConfigs` 支持 **传入 override map**（为 v1.1 仅本次做准备）

MVP 可不改 store schema。

### 6.3 运行时层（Subagent）

原则上 **零改动**：

- `createSubagentTool({ roleLlmConfigs })` 已支持按 `args.profile` 取覆盖
- 内置 `defaultProfiles` 名称与角色名一致：`researcher` / `coder` / `reviewer`

需验证的调用链：

```text
runAgentTurn
  → tools 含 subagent / subagent_batch
  → factory.getTools({ parentLlm, roleLlmConfigs })
  → 子调用 profile="coder"
  → roleLlmConfigs["coder"] 生效
```

### 6.4 Orchestration / Pipeline 层

`PipelineOrchestrator` 当前创建 subagent 时主要注入 `parentLlm`，**未见完整 `roleLlmConfigs` 透传**。

MVP 产品话术：

- `/multi-agent` 的 `planner_worker_reviewer` 今日实质是 **提示词模式标签 + 主 Agent 自行委派 subagent**
- 因此只要主 Agent 走 `subagent` 工具，角色绑定即可生效
- 若后续主 Agent 调用 `development_pipeline` 工具，则可能仍偏 parentLlm

文档要求：

1. MVP 验收以 `subagent(profile=...)` 路径为准
2. Follow-up issue：`createPipelineTool` / `PipelineOrchestrator` 接收并转发 `roleLlmConfigs`
3. 不在 MVP 扩大 pipeline 重构范围

---

## 7. 交互文案（草案）

### 7.1 角色步骤 Notice

```text
多智能体向导 — 配置子角色模型

主模型: provider/model
模式: planner_worker_reviewer

为每个角色选择模型（可全部继承主模型）：
  当前角色: coder (2/3)

  0) 继承主模型
  1) cheap-coder  (deepseek/deepseek-chat)
  2) claude-main  (anthropic/claude-sonnet-4)
  n) 新建模型…

↑↓ 选择 · Enter 确认 · Esc 取消向导
```

### 7.2 新建模型

```text
为 coder 新建模型
1/3 Model ID（如 openai/gpt-4o-mini）
2/3 Base URL
3/3 API Key
```

### 7.3 启动摘要

```text
多智能体任务即将启动
Orchestrator: anthropic/claude-sonnet-4
Mode: planner_worker_reviewer
Roles:
  researcher → inherit
  coder      → cheap-coder
  reviewer   → inherit
```

apiKey 永不展示。

---

## 8. 影响面与兼容性

### 8.1 对现有逻辑的影响

| 模块 | 影响 | 说明 |
|------|------|------|
| `/multi-agent` 向导 | **高** | 新增步骤与状态 |
| `RoleSetupState` | 低 | 保留；可共享 helper |
| `profile-store` | 低～中 | 更多写入；schema 可不改 |
| `subagent/tool` 解析优先级 | **无** | 复用 |
| `buildRoleLlmConfigs` | 中 | 缓存失效条件需修 |
| `SubagentToolsFactory` | 中 | 依赖比较需加强 |
| `PipelineOrchestrator` | 低（MVP）/ 中（follow-up） | 暂不改，有语义缺口 |
| 会话历史 / transcript | 低 | 不写 key；可写角色摘要 |
| `/model` `/profiles` | 低 | 继续可用；新建 profile 可出现在列表 |

### 8.2 向后兼容

- 不跑新步骤的老用户：不受影响
- 新步骤默认继承：与旧行为一致
- `subagentRoles` 已有绑定：向导应预填当前绑定，而不是清空

### 8.3 安全

- apiKey 输入 mask（已有 model-setup 模式）
- notice / USER_MESSAGE 禁止回显 key
- profile 文件权限保持现有 store 行为（若有 umask/mode 约定则沿用）
- 不把 key 传入 `sharedContext` 或 task 文本

### 8.4 双 TUI 入口漂移风险

App.tsx 与 terminal-main.ts 目前已有部分 slash 逻辑双份。  
本功能若只改一端，会造成「同一命令两套行为」。  
实现计划必须 **两端同发** 或先抽共享模块再接线。

---

## 9. 错误处理

| 场景 | 处理 |
|------|------|
| baseUrl 为空 | 停留在字段，提示必填 |
| apiKey 为空且无 fallback | 拒绝保存 |
| model id 无法 resolve | 允许作为 openai-compatible 自定义模型保存（与现有 `/model` 行为对齐）；若现有逻辑会 throw，则展示错误并留在向导 |
| saveProfile 失败 | 展示错误，不推进角色 |
| setSubagentRole 失败 | 展示错误，不启动任务 |
| 角色配置一半取消 | 已保存 profile 保留；未确认的 draft 丢弃；是否回滚已写 `subagentRoles`：**MVP 不回滚**（与现 role-setup 一致），但在取消文案中说明 |
| 启动时 factory 仍用旧 configs | 实现必须在 save 后强制重建 tools |

---

## 10. 测试计划（实现阶段）

### 10.1 单元

- `MultiAgentSetupState` 步进纯函数（若抽出 reducer/helper）
- 角色 assignment → `setSubagentRole` 映射
- profile 命名冲突
- `buildRoleLlmConfigs` / factory 在 role map 值变化时重建

### 10.2 集成 / TUI 级

- `/multi-agent` 完整向导：继承全部 → 启动
- coder 选已有 profile → 启动后 subagent(profile=coder) 使用该 baseUrl
- coder 新建 url/key → models.json 出现 profile 且 subagentRoles.coder 指向它
- Esc 取消不启动任务
- 预填任务路径仍经过角色确认

### 10.3 回归

- 主模型切换后 role-setup 仍可用
- `/profiles` 列表含新建 profile
- 未绑定角色仍继承 parentLlm
- apiKey 不出现在 transcript 快照测试

### 10.4 手动验收清单

1. 主模型 A，coder 配模型 B（不同 baseUrl）  
2. 任务中让主 Agent 明确调用 subagent coder  
3. 观察请求打到 B（可用代理日志 / runtimeInfo 事件）  
4. 重启进程后，再次 `/multi-agent` 看到 coder 预填为 B  

---

## 11. 分期与工作量

### 11.1 MVP（本设计默认范围）

- 向导增加 roles + 新建模型子流程
- 保存为全局默认（`subagentRoles`）
- 打通 `roleLlmConfigs` 注入与 factory 失效
- App + terminal 双入口
- 基础测试

**预估：1.5–2.5 人日**

### 11.2 v1.1

- 持久化选择：`仅本次` / `保存为默认`
- 会话级 `roleLlmConfigs` override（不写 store 或写 session meta）
- 抽取共享 `multi-agent-wizard` 模块
- `PipelineOrchestrator` 透传 `roleLlmConfigs`

**预估：+1–1.5 人日**

### 11.3 v1.2（可选）

- 角色矩阵一屏总览编辑（非逐步）
- 从环境变量批量导入角色模型
- 按 mode 推荐默认矩阵（例如 planner 用强模型、worker 用便宜模型）

### 11.4 备选：MVP 就上「仅本次」

若产品强需求，最小做法：

- 向导结束不调用 `setSubagentRole`
- 直接把 assignment 编译成 `Record<role, LlmConfig>`
- 经 `getSubagentTools` / factory 传入
- store 不变

代价：与现有 role-setup 两套来源，需在 UI 标明“本次临时”。  
本设计 **不作为默认 MVP**，仅记录。

---

## 12. 实现任务拆解（供后续 implementation plan 使用）

> 本节是设计级拆解，不是可执行的 coding checklist；正式开工前另写 implementation plan。

1. **类型与 mode**  
   扩展 `MultiAgentSetupState`、`AcMode`、overlay 文案。
2. **共享绑定 helper**  
   `applyRoleAssignments(assignments) → void`（save profile + set roles）。
3. **terminal 向导接线**  
   `/multi-agent` 在 mode 之后进入 roles；roles 完成进 task。
4. **App.tsx 对齐**  
   相同状态机。
5. **Factory 缓存键修复**  
   roleLlmConfigs 内容变化必须重建。
6. **启动摘要 notice**  
   不含 key。
7. **测试**  
   store 映射 + 向导步进 + 回归 role-setup。
8. **文档**  
   更新 `docs/multi-agent-orchestration-design.md` 增加「启动前角色模型配置」交叉链接；更新 slash help。

---

## 13. 开放问题（实现前需产品确认）

| # | 问题 | 默认假设 |
|---|------|----------|
| 1 | MVP 是否只要「保存为默认」？ | 是 |
| 2 | 预填任务是否仍强制经过角色步骤？ | 是，但可「全部继承并继续」 |
| 3 | 是否两端 TUI 同发？ | 是 |
| 4 | pipeline 透传是否阻塞 MVP？ | 否 |
| 5 | 取消向导是否回滚已写 subagentRoles？ | 否 |
| 6 | 新建 profile 是否设为 active 主 profile？ | 否，仅绑定角色，不切换主会话 active |

---

## 14. 建议的最终决策（设计推荐）

1. **做** `/multi-agent` 内角色模型配置向导。  
2. **复用** profile store，不新造凭证系统。  
3. **MVP 持久化** = 保存为默认 `subagentRoles`。  
4. **默认选项** = 继承主模型。  
5. **新建** = model + url + key → profile → 绑定。  
6. **执行层** 尽量不改，只修注入与缓存。  
7. **pipeline 对齐** 单列 follow-up，不堵 MVP。  
8. **本阶段只产出文档，不改代码。**

---

## 15. 附录：现有模型解析优先级（实现约束）

来源：`src/subagent/tool.ts`

```text
args.model
  > profile.llm          # SubagentProfile 内嵌 llm（内置 defaultProfiles 通常无）
  > roleLlmConfigs[role] # 来自 subagentRoles → ModelProfile
  > parentLlm            # 主会话
```

本设计只向 `roleLlmConfigs[role]` 灌数，不试图改变优先级，以避免破坏 `args.model` 显式覆盖语义。

---

## 16. 附录：与既有文档关系

- 父文档：`docs/multi-agent-orchestration-design.md`（管道与 Route A/B）
- 本文：启动 UX 与角色 LLM 配置层
- 不替代 orchestration 管道设计；互补

实现完成后应在父文档 §4 增加一小节：

> 「启动前可通过 `/multi-agent` 向导为 researcher/coder/reviewer 绑定独立 model profile。」
