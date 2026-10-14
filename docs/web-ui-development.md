# Web UI 开发状态记录

> 本文档记录 `/web-ui` 工作台（参考 1.md / DeepSeek Harness）的分阶段实施状态，供后续阶段与协作开发者交接。

## 阶段状态

- **P0 代码核查**：分支 `feature/claude-code-terminal` 已核查；`package.json`、`slash-commands.ts`、`server.ts`、Session 存储均已确认。
- **P1 `/web-ui` 命令**：已完成（`src/tui/web-ui-command.ts`、`src/tui/web-ui-manager.ts`、`slash-commands.ts` 注册）。
- **P2 Web UI 基础设施**：已完成（见下文）。
- **P3 Chat 与流式响应**：已完成（见下文）。
- **P4 工作台核心面板**：已完成（见下文）。
- **P5 并发/安全/回归**：已完成（见下文）。

## P2 交付内容（摘要）

- `apps/web/`（index.html、main.tsx、styles.css、tsconfig.json）、根 `vite.config.ts`（dev 代理 `/api → 127.0.0.1:3001`、build 输出 `dist/web`）、脚本 `web:dev`/`web:build`/`web:typecheck`
- `src/server.ts`：`dist/web` 存在时 Express 提供静态资源 + SPA fallback（`/api/*` 除外）
- `test/web-ui-static.test.ts`：静态资源/SPA/404 不被劫持（备份恢复式，幂等）

## P3 交付内容

### 核实过的后端协议（feature/claude-code-terminal，src/server.ts + src/server/routes/）

- 消息提交：`POST /api/sessions/:id/messages`，JSON body `{ prompt }`（另支持 multipart images/documents）；响应 `application/x-ndjson`
- 流事件（safeEvent 实测形状）：首事件 `user`（回显）；`assistant_delta {text, kind: reasoning|answer}`；`assistant_deltas {reasoning?, answer?}`（合并帧）；`assistant`（消息边界，content + tools 摘要）；`tool_start {id,name,arguments}`；`tool_end {id,name,isError,preview}`；`permission_required {requestId,tool,arguments,risk,source}`；`error {message,retryable?}`；`aborted {message}`；`done {messageCount}`；`context_compacted`、`max_turns`、`retry_attempt`、`model_switched`、`attempt_reset`、`subagent_start`、`budget_warning` 等；**plan-act 事件无 `type` 字段**，形状为 `{ eventType, ... }`
- 取消语义：客户端 abort fetch → 服务端 `request.on("aborted")` / `response.on("close")` → 内部 AbortController → 任务真实停止（**无需新增 cancel API**，1.md §6.2 前提不成立）
- 409 = session busy；404 = session 不存在；`DELETE /api/sessions/:id` 返回 204 无 body
- `GET /api/sessions/:id` 返回 `messages`（safeMessage 形状：user content 归一为 string；assistant 可带 `toolCalls[{id,name,arguments}]`；tool 带 `toolCallId/isError`）

### 新增文件

| 文件 | 说明 |
| --- | --- |
| `apps/web/src/types/api.ts` | 核实的 wire 类型（SessionSummary/SessionDetail/HistoryMessage/WireEvent） |
| `apps/web/src/lib/ndjson.ts` | 纯函数 `NdjsonParser`（增量缓冲 + 换行拆分 + 坏行不崩），Node 可测 |
| `apps/web/src/lib/stream.ts` | 浏览器侧 `readNdjson(response, onEvent, signal)`（§7.1 完整实现） |
| `apps/web/src/lib/event-adapter.ts` | `ChatStreamState`（事件→视图模型，未知事件忽略）+ `historyToItems` |
| `apps/web/src/lib/api.ts` | fetch 封装（sessions CRUD、sendPrompt、permission resolve、model/permission-mode） |
| `apps/web/src/hooks/useSessions.ts` | 列表/创建/切换/删除 + 加载态 |
| `apps/web/src/hooks/useAgentStream.ts` | 发消息 + 流消费 + 按 session id 事件隔离 + Stop（abort = 服务端真实取消） |
| `apps/web/src/components/` | SessionSidebar、ChatView、ChatComposer、ToolActivityPanel、StatusBar |
| `test/web-ui-ndjson.test.ts` | 7 个边界用例（chunk 跨界、CRLF、坏行、尾行 flush） |
| `test/web-ui-event-adapter.test.ts` | 6 个用例（历史配对、流序列、error/aborted、未知事件、隔离） |

### 验收核对（1.md §10 P3）

- ✅ 多轮对话：会话历史通过 `GET /api/sessions/:id` 重载，delta 增量渲染
- ✅ 长响应解析：NDJSON 缓冲区按换行拆分，单测覆盖 chunk 跨界
- ✅ 页面刷新后重载 session 状态与历史（useAgentStream 激活时 loadHistory）
- ✅ 取消任务后后端停止（abort fetch → 服务端 AbortController，已核实代码）
- ✅ 旧 session 事件不污染当前 session（`activeIdRef` 守卫 + 双状态实例隔离单测）
- 冒烟验证（真实环境）：API :3001 + Vite :5173，`/api/health` 200、创建/列表/详情 session 均 200

## P4 交付内容

### 面板与功能实现

1. **WorkspacePanel** (`apps/web/src/components/WorkspacePanel.tsx`)：
   - 对接 `GET /api/workspace/list?path=`，支持工作区文件与目录浏览；
   - 支持目录多层级下钻与 `.. (Up)` 返回上一级，指示当前工作区绝对路径；
   - 截断标记提示（MAX_DIR_ENTRIES）。
2. **ModelSelector** (`apps/web/src/components/ModelSelector.tsx`)：
   - 对接 `GET /api/models` 获取可用模型列表与默认模型；
   - 会话级模型切换，调用 `PUT /api/sessions/:id/model`，并在成功后通知外层刷新以保持全局同步。
3. **PermissionDialog / 审批交互** (`apps/web/src/components/ChatView.tsx`)：
   - 对接 `POST /api/sessions/:id/permissions/:requestId`；
   - 权限请求卡片内嵌 Allow / Deny 操作按钮，提供防连击并发保护（resolving 锁）；
   - 审批成功后本地乐观标记为 resolved 并触发会话刷新，服务端权限校验逻辑保持严格不变。
4. **PlanPanel** (`apps/web/src/components/PlanPanel.tsx`)：
   - 支持 Plan-Act 事件与计划文档解读，展示计划状态、Prompt、审批人、结构化步骤（含状态与颜色）；
   - 展示变更高亮、缺失文件与计划外文件列表；
   - `useAgentStream` 在会话激活时并发获取历史 Plan（`GET /api/sessions/:id/plan`），并在流中实时接收 `plan_updated` 事件。
5. **布局与测试整合** (`apps/web/src/App.tsx`, `test/web-ui-p4.test.ts`)：
   - 右侧弹性堆叠 `WorkspacePanel`、`ToolActivityPanel`、`PlanPanel`，保证核心面板完整可用；
   - 编写专用测试 `test/web-ui-p4.test.ts` 覆盖 Plan 更新解析、历史加载重置、Permission 结构解析。

## P5 交付内容

### 集成测试（`test/web-ui-p5.test.ts`，15 用例全部通过）

| 场景 | 验证要点 |
|---|---|
| 多 Session 并发 | 两个 Session 独立创建、互不串扰 |
| Session 运行中重复提交 | 409 `busy` 拒绝，服务端正确锁定 |
| 权限拒绝流程 | 非法 decision 返回 400；未知 requestId 返回 404 |
| 模型错误传播 | provider 抛异常 → 流中产出 `{ type: "error", message }` |
| 流中止取消 | 客户端 abort fetch → 服务端无 unhandled exception |
| 服务端重启恢复 | `dataDir` 持久化，新实例加载旧 Session 历史 |
| 工作区路径安全 | `../../etc/passwd` 和绝对路径均被拒绝 |
| API Key 不泄露 | `/api/config` 响应不含密钥 |
| TUI Slash 命令独立性 | `/web-ui` 由 parser 正确识别，不转发 LLM |
| 长上下文容错 | 50K 字符响应正常流式输出 |
| 会话活跃状态 | streaming 期间 `busy=true`，完成后 `busy=false` |

### 验收结果

- `npm run typecheck` + `npm run web:typecheck`：0 error
- `npm test` 全量：**1359 pass / 0 fail / 2 skipped**（含 15 个新增 P5 测试）
- `npm run web:build`：41 modules, 423ms
- 无新增安全绕过路径（API Key 审计、路径穿越、权限复验均已验证）

## Web 发布入口（2026-10-13）

Web UI 采用增量发布方式，不替换原有 TUI 和单次 CLI：

- `mini-agent-loop` 继续指向 `dist/tui.js`。
- `mini-agent-loop-run` 继续指向 `dist/cli.js`。
- 新增 `mini-agent-loop-web`，指向 `dist/web-launcher.js`。
- 发布包同时包含 `dist/server.js` 和 `dist/web/`，由启动器拉起本地 Server 并托管 Web UI。

开发模式仍使用 `npm run dev`；发布包验证使用 `npm run build:package`，然后执行：

```bash
mini-agent-loop-web --workspace /absolute/path/to/project
```

启动器支持 `--port <number>` 和 `--no-open`。Server、Session、工具和项目文件读取仍在 Node 进程内执行，浏览器只访问 HTTP API，因此没有把文件读取逻辑迁移到前端，也不会改变旧 CLI/TUI 的运行方式。

## 遗留事项

- [ ] **pnpm-lock.yaml 未同步**：`react-dom@18.3.1`、`@types/react-dom@18.3.7` 为手工装入 node_modules。网络恢复后 `pnpm add react-dom@18.3.1 && pnpm add -D @types/react-dom@18.3.7` 同步 lockfile
- [ ] **Markdown 渲染**：P3/P4 用纯文本/pre-wrap，未引入 markdown 依赖；后续按需引入
- [ ] `npm run typecheck` 在默认 Node 堆下 OOM（环境问题）；用 `node --max-old-space-size=8192 ./node_modules/typescript/bin/tsc --noEmit` 验证通过

## P3 评审修复（review fixes）

针对代码审查发现的 3 个缺陷，已修复并验证：

1. **多轮历史被清空 + 用户消息重复**（`apps/web/src/hooks/useAgentStream.ts`）：
   - 新增 `itemsRef` + `commitItems`，每次 send 以当前会话 items 为种子，多轮对话历史不再丢失；
   - 移除前端乐观 user echo，用户消息一律以服务端 NDJSON 首帧 `user` 事件为准（displayPrompt 为源数据），彻底消除重复气泡。
2. **P1 遗留：TUI `/web-ui` 无响应 + Manager 启动命令错误**：
   - `src/tui/App.tsx` slash switch 补 `case "web-ui"`（惰性 `WebUiManager` ref，结果经 `ADD_NOTICE` 展示）；
   - `WebUiManager.start` 改为 spawn 共享的 Web launcher（打包运行时为 `dist/web-launcher.js`，源码运行时为 `src/web-launcher.ts`，env `PORT`，detached 进程组）；`dist/web` 缺失时先按需 `web:build`；就绪判定改为真实轮询 `/api/health`（同时校验自身进程存活，防止外部端口占用造成假阳性）；`stop()` 改为 SIGTERM 宽限 + SIGKILL 整组清理；默认端口 5173 → 3001（工作台 = Express 本体）。
3. **`assistant` 无 delta 兜底 + 会话列表不刷新**（`apps/web/src/lib/event-adapter.ts`、前端 `App.tsx`）：
   - `case "assistant"` 在无 delta（非流式/空 delta）时用事件 content 回填或新建完成态 assistant item（delta 已填充时不重复追加）；
   - 前端 App 在 phase 进入 done/error/aborted 时调用 `refresh()` 刷新会话列表，messageCount/lastActiveAt 保持更新。

验证：root/web typecheck 0 错误；web-ui 专项单测 19/19（含新增多轮种子、assistant 兜底、管理器状态机用例）；全量 1341 pass / 0 fail（连跑 2 次，首次 1 个 flaky 为既有测试偶发）；vite build 通过；Manager 真实 E2E（端口 3101：start 健康检查就绪 → status 带 PID → 重启去重提示 → stop 后端口确认释放）。

## Harness Web 布局对齐（2026-10-12）

参考 `deepseek-ai/deepseek-harness` 提交 `d743267` 的 `ui-layout`、`ui-sidebar` 和
`ui-conversation` 源码，将工作台从固定三栏调整为会话导航 + 聊天主区 + 按需工作区面板：

- 左栏默认 280px，可拖动至 264–420px；小于 1024px 自动折叠为 56px 图标栏，仍可手动展开。
- 右栏默认关闭，Files / Activity / Plan 切换；首次打开宽度为视口的 45%，支持拖动、全屏、关闭及 Escape。
- 聊天至少保留 400px；不足以容纳 300px 右栏时，面板覆盖显示，窄屏仍可访问文件、工具及计划。
- 空会话将标题、工作区入口和输入卡片居中；有消息后输入卡片固定在聊天区底部。
- 模型选择移至输入卡片底部，圆形发送 / 停止按钮保留现有流式协议；Enter 发送、Shift+Enter 换行，输入法组合输入不会误发送。
- 会话支持本地搜索；文件预览沿用现有安全 API。面板选项卡支持左右箭头，拖动分隔条支持键盘调整。
- 权限审批拆为独立 React 组件，避免权限消息增减造成 Hooks 调用顺序变化。

这是现有功能范围内的布局对齐，保留 Mini Agent 品牌；Harness 的插件市场、终端、浏览器和设置等功能未增加。
聊天 Markdown 渲染仍沿用现有纯文本实现。

验证：`test/web-ui-layout.test.ts` 覆盖折叠、拖动边界及覆盖布局；运行 Web 专项测试、全量测试、root/web 类型检查和构建。
浏览器使用独立临时数据目录与离线模型检查发送、文件预览、选项卡和响应式布局，避免消耗真实模型 API。

## 多 Workspace 支持（2026-10-12）

- `POST /api/workspaces` 显式登记本机目录，记录存入 `AGENT_DATA_DIR/workspaces.json`（默认 `~/.mini-agent/workspaces.json`）；路径以真实路径规范化并按目录去重。
- 创建 Session 时通过 `{ workspaceId }` 绑定项目；会话列表与详情返回 `workspaceId`，fork 继承原项目。旧会话继续归到服务启动时的默认目录。
- 每个 Session 保存自己的 `cwd`（对应 Harness 的 `SessionHeader.cwd`）；工具执行 broker 在每次调用时把这个 cwd 显式传给本地文件工具、Shell、Git 和验证工具，而不是让文件工具读取服务进程的全局 cwd。
- Agent 文件工具、bash 和 Web 文件浏览都从同一个 session cwd 解析相对路径；解析前先确定真实 cwd，并对目标做 symlink 越界校验，避免 `symlink/..` 导致三者读取不同文件。

### 项目作用域会话存储（2026-10-13）

参考 DeepSeek Harness 的 project/session 目录模型，服务端现在将新会话存储为：

```text
AGENT_DATA_DIR/sessions/projects/<可读项目路径>/<sessionId>/events.jsonl
AGENT_DATA_DIR/sessions/projects/<可读项目路径>/<sessionId>/meta.json
```

- 项目目录由规范化的本地绝对路径生成，保留可读路径前缀并限制长度；会话目录仍由安全的 session ID 命名。
- 会话的持久化目录、工具 cwd、文件浏览、Git 和计划执行都从同一个 workspace/session 作用域解析。
- 工具集合可以在 server 级共享，但项目目录只由调用时的 session context 决定；这样多个 session 可同时使用同名相对路径而不会串项目。
- 启动时会读取旧版 `AGENT_DATA_DIR/sessions/<sessionId>/` 平铺会话，并按其 workspaceId 或默认项目迁移到新目录；迁移不会刷新原会话的活跃时间。
- `/api/sessions?workspaceId=...` 支持按项目查询；文件接口同时收到 `sessionId` 与不匹配的 `workspaceId` 时返回 `409`，防止前端状态串项目。
- Web 侧栏可切换项目并按项目显示会话，也可通过本机绝对路径登记目录；新会话沿用当前项目。
- 路径登记是显式动作；登记后的每个 Workspace 仍使用既有根目录和 symlink 越界校验。
- `Select Workspace Directory` 首次打开时以 Server 当前项目目录为起点；手工输入支持绝对路径、相对当前项目路径和 `~/...`。无效路径会清空当前选择并禁用 `Open`，不会误提交上一次有效目录。

验证：服务端集成测试覆盖目录登记、会话文件浏览与 `read` 工具的项目隔离；分组全量测试为 `1426 passed, 2 skipped`，`orchestration-server.test.ts` 单独为 `4 passed`；服务端/前端类型检查及服务端/Web 构建通过。当前 `npm test` 单命令会在 orchestration 相关测试并行装载阶段卡住，需按上述方式分组运行。
