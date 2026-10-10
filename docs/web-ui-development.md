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
   - `WebUiManager.start` 改为 spawn `npm run serve`（`tsx src/server.ts`，env `PORT`，detached 进程组）；`dist/web` 缺失时先按需 `web:build`；就绪判定改为真实轮询 `/api/health`（同时校验自身进程存活，防止外部端口占用造成假阳性）；`stop()` 改为 SIGTERM 宽限 + SIGKILL 整组清理；默认端口 5173 → 3001（工作台 = Express 本体）。
3. **`assistant` 无 delta 兜底 + 会话列表不刷新**（`apps/web/src/lib/event-adapter.ts`、前端 `App.tsx`）：
   - `case "assistant"` 在无 delta（非流式/空 delta）时用事件 content 回填或新建完成态 assistant item（delta 已填充时不重复追加）；
   - 前端 App 在 phase 进入 done/error/aborted 时调用 `refresh()` 刷新会话列表，messageCount/lastActiveAt 保持更新。

验证：root/web typecheck 0 错误；web-ui 专项单测 19/19（含新增多轮种子、assistant 兜底、管理器状态机用例）；全量 1341 pass / 0 fail（连跑 2 次，首次 1 个 flaky 为既有测试偶发）；vite build 通过；Manager 真实 E2E（端口 3101：start 健康检查就绪 → status 带 PID → 重启去重提示 → stop 后端口确认释放）。
