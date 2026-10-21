# Mini Agent Loop Web UI 工作台集成开发文档

**项目：** `mini-agent-loop`
**功能名称：** Web Workbench
**核心入口：** `/web-ui`
**参考项目：** [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
**实施原则：** 复用 Agent Runtime、最小化侵入 TUI、服务端权限校验、分阶段交付。

---

## 1. 项目目标

在现有 `mini-agent-loop` TUI 中增加 `/web-ui` 快捷指令。用户执行命令后，系统自动启动本地 Web 工作台，并在浏览器中打开类似 DeepSeek Harness 的 Agent 开发界面。

工作台需要支持：

1. 多轮 Agent 对话和流式响应。
2. Session 创建、切换和历史恢复。
3. 工作区选择、文件树和文件引用。
4. 工具调用、执行状态和错误信息可视化。
5. 权限模式查看、操作审批和拒绝。
6. 模型切换及当前任务状态展示。
7. Plan-Act 计划、任务进度和结果展示。
8. Web 服务的启动、状态检查和停止。
9. TUI、CLI、Web 三种入口尽量复用现有 Agent 实现。

### 1.1 非目标

第一阶段不做以下事情：

* 不复制 DeepSeek Harness 的完整 Cordis 插件体系。
* 不重写 `src/loop.ts` 中的 Agent 执行循环。
* 不在浏览器端直接执行 shell 或文件修改。
* 不将 API Key 暴露给浏览器。
* 不在第一阶段强行实现 TUI 与 Web 对同一个正在执行的 Session 的双向实时同步。
* 不将工作台部署到公网。

---

## 2. 现有代码分析与集成边界

### 2.1 已确认的代码入口

以下路径来自可读取的公开默认分支，实施时必须再对照目标分支检查。

| 文件或目录                       | 现有职责                                 | 集成方式                    |
| --------------------------- | ------------------------------------ | ----------------------- |
| `src/tui/App.tsx`           | Ink TUI 主交互和输入提交                     | 增加 `/web-ui` 命令处理       |
| `src/tui/slash-commands.ts` | Slash Command 注册、解析及帮助信息             | 注册 `/web-ui`            |
| `src/tui/ink-main.tsx`      | TUI 入口及资源初始化                         | 原则上不改 Agent 主流程         |
| `src/server.ts`             | Express Server、Session API、消息流和运行时组装 | 增加 Web 静态资源服务和生命周期接口    |
| `src/server/routes/`        | HTTP API 分域路由                        | 新增必要的 Web 状态路由，尽量复用已有路由 |
| `src/session-manager.ts`    | Session 选择、恢复和持久化协调                  | 复用现有 Session 规则         |
| `src/session-store.ts`      | Session 持久化、恢复及存储锁                   | 保持现有存储格式                |
| `src/loop.ts`               | Agent 执行循环                           | 不为 Web UI 复制或重写         |
| `src/permissions.ts`        | 工具权限策略及权限请求                          | Web 操作继续走服务端权限体系        |
| `docs/architecture.md`      | 当前整体架构说明                             | 完成后同步更新                 |

参考链接：

* [TUI App](https://github.com/Chrischen996/mini-agent-loop/blob/main/src/tui/App.tsx)
* [Slash Commands](https://github.com/Chrischen996/mini-agent-loop/blob/main/src/tui/slash-commands.ts)
* [HTTP Server](https://github.com/Chrischen996/mini-agent-loop/blob/main/src/server.ts)
* [Architecture](https://github.com/Chrischen996/mini-agent-loop/blob/main/docs/architecture.md)
* [Security Model](https://github.com/Chrischen996/mini-agent-loop/blob/main/docs/security-model.md)

### 2.2 推荐的整体架构

```text
                  mini-agent-loop
                         |
           +-------------+-------------+
           |             |             |
          TUI            CLI          Web UI
           |             |             |
           |             |       React + Vite
           |             |             |
           +-------------+-------------+
                         |
                  HTTP / API Layer
                         |
                 Session Management
                         |
                  Agent Runtime
                         |
          +--------------+--------------+
          |              |              |
       LLM Layer      Tool Registry   Permission
          |              |              |
          +--------------+--------------+
                         |
                 Session Persistence
```

架构约束：

* Agent Runtime 是执行逻辑的唯一实现来源。
* Web UI 只负责展示状态、收集用户输入和提交操作。
* 服务端负责消息执行、工具调用、路径验证和权限校验。
* Session 持久化继续使用已有格式。
* 前端不直接导入或执行 Agent 内核代码。

**重要：共用 Agent 代码，不等于两个界面天然共享同一个运行中的 Session 对象。** 当前 TUI 和 HTTP Server 分别组装运行环境。需要通过明确的 Session 协议、运行状态协调和并发控制，才能安全地让两个界面操作同一个 Session。

---

## 3. 功能需求

### 3.1 Slash Command

实现以下命令：

| 命令                    | 行为                |
| --------------------- | ----------------- |
| `/web-ui`             | 启动或复用工作台，并打开浏览器   |
| `/web-ui --no-open`   | 启动工作台，但不自动打开浏览器   |
| `/web-ui --port 3080` | 指定 HTTP 端口        |
| `/web-ui status`      | 查看工作台状态           |
| `/web-ui stop`        | 停止当前 TUI 管理的工作台实例 |
| `/web-ui help`        | 展示用法              |

约束：

1. `/web-ui` 必须由 Slash Command Router 处理，不得发送给大模型。
2. 未知参数应返回帮助提示。
3. 重复执行启动命令时，应复用现有实例，而不是重复监听端口。
4. 自动打开浏览器失败时，仍应输出可复制的本地 URL。
5. 不允许停止其他进程占用的端口。
6. 命令执行失败不能导致 TUI 崩溃。

### 3.2 Web 工作台界面

首版采用单页面工作台布局。

```text
+-----------------------------------------------------------+
| Mini Agent Workbench      Model: ...      Permission: ... |
+------------------+----------------------+-----------------+
|                  |                      |                 |
| Session List     | Conversation         | Workspace       |
|                  |                      |                 |
| New Session      | User Message          | File Tree       |
| History          | Assistant Response    | File Preview    |
| Search           | Tool Activity         |                 |
|                  | Input Composer        |                 |
|                  | Send / Stop           |                 |
+------------------+----------------------+-----------------+
| Task Status / Plan / Permission Requests / Error Details  |
+-----------------------------------------------------------+
```

界面模块：

* `SessionSidebar`：Session 列表和切换。
* `ChatView`：消息历史及 Markdown 渲染。
* `ChatComposer`：消息输入、发送和取消。
* `ToolActivityPanel`：工具调用、参数摘要、结果和错误状态。
* `WorkspacePanel`：工作区文件树和文件引用。
* `PermissionDialog`：权限请求和用户决策。
* `ModelSelector`：模型选择。
* `PlanPanel`：任务计划、执行状态和结果。
* `StatusBar`：连接状态、当前模型和任务状态。

首版不要求复制 Harness 的全部 UI 组件；应先保证功能完整、交互稳定。

---

## 4. 技术方案

### 4.1 前端技术栈

推荐：

* React
* TypeScript
* Vite
* React DOM
* 原生 `fetch` 和 `AbortController`
* 现有项目允许的 UI 组件与样式方案

不要为首版引入复杂的插件运行时、微前端系统或独立 Agent 状态管理框架。

当前公开 `main` 的 `package.json` 已包含 React、TypeScript 和 Vite 相关依赖，但是否需要增加 `react-dom`、类型包或其他依赖，必须以目标分支的实际 `package.json` 为准。

### 4.2 建议目录结构

以下是新增 Web UI 后的目标结构，不代表这些文件已经存在。

```text
mini-agent-loop/
├── src/
│   ├── tui/
│   │   ├── App.tsx
│   │   └── slash-commands.ts
│   ├── server.ts
│   ├── server/
│   │   └── routes/
│   ├── session-manager.ts
│   ├── session-store.ts
│   └── loop.ts
├── apps/
│   └── web/
│       ├── index.html
│       └── src/
│           ├── main.tsx
│           ├── App.tsx
│           ├── components/
│           │   ├── SessionSidebar.tsx
│           │   ├── ChatView.tsx
│           │   ├── ChatComposer.tsx
│           │   ├── ToolActivityPanel.tsx
│           │   ├── WorkspacePanel.tsx
│           │   ├── PermissionDialog.tsx
│           │   ├── ModelSelector.tsx
│           │   └── PlanPanel.tsx
│           ├── hooks/
│           │   ├── useSessions.ts
│           │   ├── useAgentStream.ts
│           │   └── useWorkspace.ts
│           ├── lib/
│           │   ├── api.ts
│           │   ├── ndjson.ts
│           │   └── event-adapter.ts
│           ├── types/
│           │   └── api.ts
│           └── styles/
├── docs/
│   └── web-ui-development.md
├── vite.config.ts
└── package.json
```

如果仓库已有 GUI 目录或相同职责的组件，应优先扩展现有代码，不要再创建一套重复组件。

### 4.3 开发与生产环境

开发模式：

```text
Browser
  |
  +--> Vite: 127.0.0.1:5173
  |       |
  |       +--> /api proxy
  |
  +--> Express API: 127.0.0.1:3001
```

生产模式：

```text
Browser
  |
  v
Express Server: 127.0.0.1:3001
  |
  +--> Web UI static assets
  |
  +--> /api/*
```

推荐 Vite 开发端口为 `5173`，API 默认端口继续使用项目现有的 `3001`。如果目标分支已有端口配置，应遵循已有约定。

生产环境由 Express 提供打包后的静态资源，不应要求用户额外启动 Vite。

---

## 5. 服务启动与生命周期

### 5.1 推荐设计

第一阶段采用独立的本地 Web Server 进程，由 TUI 中的 Web UI Manager 管理。

```text
TUI
 |
 +--> /web-ui
       |
       v
   WebUiManager
       |
       +--> 检查实例状态
       |
       +--> 选择空闲端口
       |
       +--> 启动 Web Server 子进程
       |
       +--> 等待 /api/health 就绪
       |
       +--> 输出 URL
       |
       +--> 可选打开浏览器
```

采用独立进程的原因：

* 不让 Web Server 的生命周期和 Ink 的渲染生命周期互相干扰。
* 避免 TUI 退出时无法可靠清理 HTTP Server。
* 可以分别处理启动失败、端口冲突和进程退出。
* 保持现有 TUI 主流程稳定。

Web Server 必须复用现有的 `createAgentServer`、Session 管理和工具初始化逻辑，不得重新实现一套 Agent Loop。

### 5.2 生命周期状态

定义内部状态：

```ts
type WebUiStatus =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "failed";
```

要求：

* `starting`：禁止重复启动。
* `running`：再次执行 `/web-ui` 时复用 URL。
* `stopping`：等待正常退出。
* `failed`：输出具体错误，允许再次启动。
* `stopped`：允许重新启动。

Manager 需要记录其创建的子进程 PID、端口和启动时间，但不能仅凭 PID 文件就断定进程仍在运行；必须进行健康检查。

### 5.3 端口与进程安全

当前公开 `main` 中，`src/server.ts` 默认监听 `127.0.0.1:3001`。实现时必须保留本地绑定策略，不能为了浏览器访问直接改成 `0.0.0.0`。

端口策略：

1. 优先使用用户指定端口。
2. 未指定时使用 Web UI 默认端口。
3. 若端口冲突，应报告错误或尝试预定的备用端口。
4. 最终使用的端口必须反映在实际启动 URL 中。
5. 停止服务时只结束由当前 Manager 创建且身份匹配的进程。

如果要支持多个 TUI 实例，需为每个工作台实例建立独立的进程记录和资源清理机制。

---

## 6. HTTP API 设计

优先复用现有 API，而不是建立一套重复的 Web 专用业务接口。

### 6.1 现有 API

当前公开 `main` 的架构文档列出了以下接口域：

| 接口                                              | 用途              |
| ----------------------------------------------- | --------------- |
| `GET /api/health`                               | 服务健康检查          |
| `GET /api/config`                               | 公开配置和运行信息       |
| `GET /api/models`                               | 模型发现            |
| `GET /api/workspace/list?path=`                 | 工作区文件列表         |
| `POST /api/sessions`                            | 创建 Session      |
| Session CRUD 路由                                 | 列表、读取、恢复、删除等操作  |
| `POST /api/sessions/:id/messages`               | 提交用户消息并接收流式响应   |
| `PUT /api/sessions/:id/model`                   | 切换 Session 模型   |
| `GET /api/sessions/:id/permission-mode`         | 获取权限模式          |
| `PUT /api/sessions/:id/permission-mode`         | 修改权限模式          |
| `POST /api/sessions/:id/permissions/:requestId` | 解决权限请求          |
| `/api/sessions/:id/plan*`                       | 计划相关操作          |
| `/api/sessions/:id/plans`                       | Plan-Act 计划相关操作 |

具体请求字段、响应结构和路由方法必须以目标分支的实际实现为准。

参考：[Architecture.md](https://github.com/Chrischen996/mini-agent-loop/blob/main/docs/architecture.md)。

### 6.2 建议新增的接口

仅在已有 API 无法满足需求时增加接口。

**工作台运行信息：**

```http
GET /api/web-ui/status
```

示例响应：

```json
{
  "ok": true,
  "version": "1",
  "workspace": "/path/to/project"
}
```

只返回允许公开的字段，不返回 API Key、环境变量全集或服务器内部敏感路径。

**Session 运行状态：**

```http
GET /api/sessions/:id/status
```

示例：

```json
{
  "sessionId": "session-id",
  "status": "idle"
}
```

`idle`、`running`、`waiting_permission` 等值只是建议的协议状态，必须与现有运行时状态做适配，不能假设现有代码已经使用这些名称。

**取消正在执行的请求：**

如果现有消息接口尚未提供可复用的取消机制，应增加明确的取消 API，并使用服务端已有的 AbortController 或请求中止逻辑。不要在前端仅停止读取流，却让后端 Agent 继续执行。

### 6.3 API 兼容原则

* 不删除或修改现有接口的语义来迁就前端。
* 新增接口尽可能使用现有 Session 和权限管理。
* 统一错误结构。
* 对不存在的 Session 返回 `404`。
* 对正在执行的 Session 的冲突操作返回明确错误，建议使用 `409`。
* 对无效请求返回 `400`。
* 不把内部异常堆栈直接返回给浏览器。

---

## 7. NDJSON 流式消息处理

### 7.1 必须使用增量解析

消息接口的响应是流式数据。浏览器读取到的网络 chunk 不一定等于一条完整 JSON 消息。

错误做法：

```ts
// 错误：不能保证每个 chunk 都是完整 JSON
const value = JSON.parse(chunk);
```

正确做法是维护一个字符串缓冲区，持续追加字节解码结果，并按换行符拆分完整记录。

```ts
export async function readNdjson(
  response: Response,
  onEvent: (event: unknown) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  if (!response.body) {
    throw new Error("Response body is unavailable");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }

      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });

      let newlineIndex = buffer.indexOf("\n");

      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);

        if (line) {
          onEvent(JSON.parse(line));
        }

        newlineIndex = buffer.indexOf("\n");
      }

      if (done) break;
    }

    if (buffer.trim()) {
      onEvent(JSON.parse(buffer));
    }
  } finally {
    reader.releaseLock();
  }
}
```

生产实现还必须考虑错误行处理、取消语义、超大记录限制和服务端实际的终止事件格式。若当前 API 对流结束有额外协议，应遵循现有协议。

### 7.2 事件适配层

不要让每个 React 组件直接处理后端原始事件。

新增：

```text
apps/web/src/lib/event-adapter.ts
```

负责把现有 `LoopEvent`、工具事件和 Session 事件转换为前端统一状态。

前端可采用如下内部事件类型：

```ts
type WebAgentEvent =
  | { type: "assistant_delta"; text: string }
  | { type: "assistant_message"; message: unknown }
  | { type: "tool_start"; toolCall: unknown }
  | { type: "tool_end"; result: unknown }
  | { type: "permission_required"; request: unknown }
  | { type: "plan_updated"; plan: unknown }
  | { type: "error"; message: string }
  | { type: "done" };
```

这只是前端内部建议类型，不是对当前后端实际事件名称的断言。适配层必须根据现有事件定义编写，避免伪造事件或丢失重要信息。

### 7.3 前端状态管理

建议把状态划分为：

```text
Session State
  ├── messages
  ├── activeSessionId
  └── sessionStatus

Stream State
  ├── isStreaming
  ├── abortController
  └── streamError

Tool State
  ├── runningTools
  └── toolResults

Permission State
  └── pendingRequests

Workspace State
  ├── root
  └── fileTree
```

要求：

* 同一条流不能被重复消费。
* React 重渲染不能重复提交消息。
* 切换 Session 时，不能把旧 Session 的流事件写入新 Session。
* 页面刷新后，应重新获取 Session 状态和历史消息。
* 网络断开后，不得自动重复执行有副作用的 Agent 请求。
* 使用 `AbortController` 时，应区分取消读取和真正取消后端任务。

---

## 8. Session 与并发控制

这是整个集成中最重要的设计问题之一。

### 8.1 第一阶段：默认独立 Web Session

建议首版通过 Web API 创建或恢复 Session，但默认不直接接管 TUI 当前正在执行的 Session。

原因：

* TUI 和 HTTP Server 可能拥有不同的内存态 Session 对象。
* 文件锁不等于跨进程的 Agent 执行互斥。
* 同一个 Session 被两个入口同时修改时，可能出现消息顺序、模型状态或工具执行状态冲突。

因此，首版建议：

1. Web UI 创建独立 Session。
2. 使用现有持久化格式保存历史。
3. 提供 Session 列表和历史恢复。
4. 对正在运行的 Session 拒绝重复提交。
5. 不假设 TUI 与 Web 自动共享当前运行中的任务。

### 8.2 第二阶段：显式共享 Session

如需共享同一个 Session，必须增加或验证：

* 稳定的 Session ID。
* Session 级执行锁或租约。
* 消息提交的并发控制。
* 运行状态和事件流订阅。
* 任务取消和断线恢复。
* 跨进程权限请求状态同步。
* 避免重复执行同一条用户消息的幂等策略。

可以将 Web UI 连接到指定 Session，但在完成上述机制之前，不应允许两个界面同时向该 Session 提交任务。

---

## 9. 权限与安全设计

### 9.1 API Key

* API Key 只保存在服务端配置中。
* 前端不得读取 `process.env` 中的密钥。
* `/api/config` 只能返回必要的公开配置。
* 不把密钥写入 URL、浏览器存储、日志或异常消息。
* 不在 Web UI 的模型设置接口中返回原始密钥。

### 9.2 权限审批

现有项目的权限模式包含 `plan` 和 `bypass`。Web UI 必须遵循服务端现有规则，不能通过前端按钮直接执行工具。

需要明确：

* 隐藏按钮不是安全控制。
* 前端提交 `allow` 或 `deny` 并不意味着后端应该无条件接受。
* 服务端必须校验 Session ID、请求 ID、当前权限状态和请求有效性。
* 修改权限模式的操作必须继续使用现有服务端校验。
* Web UI 不得默认将权限模式切换到 `bypass`。

参考：[Permissions Routes](https://github.com/Chrischen996/mini-agent-loop/blob/main/src/server/routes/permissions.ts)。

### 9.3 本地访问

首版默认监听 `127.0.0.1`，不开放公网。

另外应考虑：

* 校验 `Host` 和 `Origin`，避免 DNS rebinding 与跨站请求风险。
* 对修改状态的 API 使用合适的来源校验。
* 对文件读取和文件引用继续执行工作区路径限制。
* 对上传文件执行大小和类型校验。
* 不将任意本地文件路径暴露给未经授权的页面。
* 关闭 Server 时清理 MCP、沙箱及其他运行时资源。

如果未来要支持局域网或公网访问，应单独设计认证、授权、TLS、CSRF 防护和会话隔离，不能直接取消本地绑定限制。

---

## 10. 具体实施步骤

### P0：代码核查与设计冻结

目标：确保开发落在正确分支。

任务：

1. 切换到实际开发分支 `Claude-code-terminal`。
2. 检查 `package.json`、`src/tui/slash-commands.ts`、`src/tui/App.tsx`。
3. 检查 Server 启动函数、API 路由和消息流协议。
4. 检查当前 TUI 的 Session ID 如何创建、恢复和保存。
5. 检查是否已有 Web UI 目录、构建脚本或静态资源服务。
6. 明确第一版采用独立 Web Session 还是共享 Session。
7. 形成实际文件修改清单。

**验收标准：** 不重复实现已有能力；目标分支的文件路径和实际事件结构已经核实。

### P1：实现 `/web-ui` 命令

任务：

1. 在 Slash Command Router 注册 `/web-ui`。
2. 解析 `--no-open`、`--port`、`status`、`stop` 和 `help`。
3. 新增 `WebUiManager` 管理启动状态。
4. 启动本地 Web Server 子进程。
5. 通过健康检查确认服务就绪。
6. 输出最终 URL。
7. 处理端口冲突、重复启动、进程退出和资源清理。

建议新增模块：

```text
src/tui/web-ui-command.ts
src/tui/web-ui-manager.ts
```

如果当前命令系统已有通用命令处理模块，应直接扩展现有结构。

验收标准：

* 输入 `/web-ui` 不会触发模型调用。
* 连续执行两次不会启动两个服务。
* 启动失败不会使 TUI 退出。
* `/web-ui stop` 只停止当前管理的实例。

### P2：构建 Web UI 基础设施

任务：

1. 创建或扩展 `apps/web`。
2. 配置 Vite 开发代理。
3. 配置 React、TypeScript 和构建脚本。
4. 配置 Express 提供生产静态资源。
5. 保证 API 请求不依赖跨域宽松配置。
6. 增加工作台状态接口（仅在确实需要时）。

建议新增脚本：

```json
{
  "scripts": {
    "web:dev": "vite --host 127.0.0.1 --port 5173",
    "web:build": "vite build"
  }
}
```

这些脚本只是建议，合并时需要与现有脚本协调，不应覆盖现有 `dev`、`build` 或 `serve` 命令。

验收标准：

* 开发模式可打开前端。
* 前端可请求现有后端 API。
* 生产构建生成可由 Express 提供的静态资源。
* 浏览器端不存在 API Key。

### P3：实现 Chat 和流式响应

任务：

1. 获取 Session 列表。
2. 创建 Session。
3. 读取 Session 历史。
4. 发送消息。
5. 增量解析 NDJSON。
6. 显示 Assistant 流式输出。
7. 显示工具调用和错误。
8. 实现取消、重试和断线恢复策略。

验收标准：

* 连续多轮对话正常。
* 长响应不会因为网络 chunk 边界而解析失败。
* 页面刷新后可以重新加载已保存的 Session。
* 取消任务后，后端不继续执行被取消的任务。
* 旧 Session 的事件不会污染当前 Session。

### P4：实现工作台核心面板

按以下顺序实施：

1. Workspace 文件树。
2. Tool Activity。
3. Session 切换与历史恢复。
4. 模型选择。
5. 权限模式展示和审批。
6. Plan-Act 计划与执行状态。

验收标准：

* 工具状态能够对应实际执行结果。
* 所有有副作用的操作均经过后端权限检查。
* 工作区文件访问仍受现有路径限制。
* 不存在只有 UI 显示成功、后端实际没有执行的假状态。

### P5：并发、安全和回归

重点验证：

* TUI 和 Web 分别启动及退出。
* 同一端口冲突。
* Session 正在运行时再次发送消息。
* 多个 Session 同时使用。
* 权限拒绝与审批超时。
* 模型错误、网络断开、流中止。
* Server 意外退出。
* 长上下文和大量工具事件。
* TUI 的原有交互、输入历史和命令自动补全。
* 沙箱、MCP 和权限规则没有被 Web UI 绕过。

验收标准：现有 TUI、CLI 和 Server 测试全部通过，新增 Web UI 测试通过，且没有新增的安全绕过路径。

---

## 11. 测试方案

### 11.1 单元测试

建议覆盖：

* Slash Command 参数解析。
* WebUiManager 状态机。
* 端口和 URL 处理。
* NDJSON 分块解析。
* 后端事件到前端事件的转换。
* 前端 Session 状态隔离。
* 错误消息规范化。

### 11.2 集成测试

建议覆盖：

1. 创建 Session 并发送消息。
2. 收到流式响应并正常结束。
3. 工具调用产生的事件能够展示。
4. 权限请求可以批准或拒绝。
5. Session 运行中重复提交会被正确处理。
6. Web Server 关闭后可以重新启动。
7. 前端静态资源能够正常提供。
8. 非法路径无法越过工作区边界。

### 11.3 回归测试命令

在仓库根目录执行：

```bash
npm run typecheck
npm test
npm run build
```

这些是当前公开 `main` 的脚本名称。实施前应确认目标分支仍保留这些脚本，并根据新增前端构建补充 `npm run web:build`。

---

## 12. 开发完成后的使用方式

开发完成后，预期用户流程如下：

```text
1. 启动 mini-agent-loop TUI

2. 输入：
   /web-ui

3. 系统输出：
   Web UI started
   URL: http://127.0.0.1:<actual-port>

4. 浏览器打开工作台

5. 选择或创建 Session

6. 输入任务并查看实时执行状态

7. 通过 Web UI 查看工具调用、文件状态和任务结果

8. 输入：
   /web-ui status
   检查服务状态

9. 输入：
   /web-ui stop
   停止当前工作台
```

实际端口应由服务启动结果确定，不要硬编码为某个端口。

---

## 13. 最终验收清单

* [ ] `/web-ui` 已注册为原生 Slash Command。
* [ ] 启动命令不会发送给 LLM。
* [ ] Web Server 可启动、复用、检查状态和停止。
* [ ] Web UI 可以访问现有后端 API。
* [ ] React 前端可以正常构建。
* [ ] 流式响应解析可靠。
* [ ] Session 可以创建、切换和恢复。
* [ ] Tool Activity 与实际工具执行事件一致。
* [ ] 权限审批由服务端完成验证。
* [ ] API Key 不暴露在浏览器。
* [ ] 默认仅绑定 `127.0.0.1`。
* [ ] TUI 原有命令、渲染和执行逻辑不受影响。
* [ ] 并发 Session 的执行规则清晰且经过测试。
* [ ] `typecheck`、现有测试及新增测试通过。
* [ ] 架构文档、命令帮助和使用说明已更新。

---

## 14. 给开发 Agent 的执行要求

执行开发时遵守以下约束：

1. 先检查目标分支的实际文件和依赖，不要直接套用其他分支的路径。
2. 先输出代码现状、修改清单和潜在风险，再开始编辑。
3. 优先扩展现有模块，避免建立重复的命令路由、Session 管理和权限系统。
4. 不修改 Agent Loop 的核心语义来适配 UI。
5. 不复制 DeepSeek Harness 的整个运行时。
6. 不把浏览器端当作可信执行环境。
7. 每完成一个阶段，运行对应测试并报告结果。
8. 遇到接口不匹配时，先适配真实后端协议，不要伪造后端已经支持的事件或字段。
9. 不允许用仅能展示静态界面的 Mock 替代真正的 Agent 对话和工具执行。
10. 最后提供文件变更清单、启动方式、测试结果和未完成事项。

**最终交付目标：** 用户在 `mini-agent-loop` TUI 输入 `/web-ui`，即可启动一个安全、可用的本地 Agent 工作台；工作台复用现有运行逻辑，具备流式对话、Session、工作区、工具状态和权限交互，同时不破坏现有 TUI 与 CLI。
