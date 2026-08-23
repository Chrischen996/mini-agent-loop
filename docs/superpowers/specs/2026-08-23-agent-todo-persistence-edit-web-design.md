# Agent Todo 持久化、编辑与 Web 展示设计

## 1. 背景与目标

仓库已经具备 Agent 通过 `todo_write` 维护任务快照、TUI 在输入框上方展示任务的基础能力。本次变更把这份任务快照扩展为会话级状态，并补齐三类使用入口：

- 服务端会话保存和恢复 Todo，旧会话恢复时默认使用空列表。
- TUI 支持快捷键和 `/todo` 命令进行人工维护。
- Web 实时展示并编辑当前会话 Todo。

Todo 仍然是一个完整快照，不引入 patch 语义。所有入口共用现有的 `TodoItem` 数据结构和校验规则：最多 50 项、ID 唯一、内容非空、状态只能是 `pending`、`in_progress`、`completed`，且最多一项处于 `in_progress`。

## 2. 方案选择

### 方案 A：会话持久化加 Web 轮询

把 Todo 写入现有会话 JSONL，Web 每隔固定时间请求 Todo。实现成本最低，但 Agent 更新和页面显示之间存在延迟，多个页面也会重复请求。

### 方案 B：会话持久化加 SSE 广播（采用）

把 Todo 仍然放在现有会话 JSONL 中，在服务进程内维护每个会话的 SSE 订阅者。Agent 工具和 Web 编辑都经过同一个更新函数，成功持久化后广播完整快照。Web 首次用 REST 获取状态，之后用 SSE 接收变化。

这个方案复用现有 Express 和 `SessionStore`，不要求新的基础设施，同时能满足实时展示和编辑。SSE 只负责单进程内的实时通知；真正的恢复来源仍是会话 JSONL。

### 方案 C：独立 TodoStore 加 WebSocket

为 Todo 创建独立文件、事件总线和 WebSocket 服务。它适合多进程部署和高频协作，但会引入新的存储和连接生命周期，超出当前单进程会话架构的需要。

## 3. 数据模型与一致性

### 3.1 会话字段

在 `Session` 和 `PersistedSession` 增加：

```ts
todos: TodoItem[];
todoVersion: number;
```

新建会话使用空列表和版本 `0`。恢复旧 JSONL 时，缺失字段分别按 `[]` 和 `0` 处理。每次接受一个合法完整快照，版本递增 1；非法输入不改变 Todo 和版本。

`PersistedSession` 的 `todos` 和 `todoVersion` 写入 `session_created` 与 `session_snapshot` 事件。读取 JSONL 时沿用当前快照合并字段的方式，旧事件不会阻止恢复。

### 3.2 单一更新路径

服务端提供会话级 `updateSessionTodos(session, todos, source)` 内部函数：

1. 使用 `validateTodoSnapshot` 校验输入并产生规范化副本。
2. 更新 `session.todos` 和 `session.todoVersion`。
3. 调用 `saveSession`，保证更新进入现有会话持久化链路。
4. 向该会话的 SSE 订阅者广播完整快照、版本和来源。

Agent 的 `todo_write` 回调和 Web `PUT` 都调用这条路径。TUI 是本地运行时，没有现有的服务端会话存储，因此继续在 TUI reducer 中维护同一份规范化快照；TUI 的人工入口也复用同一套纯更新辅助函数。

### 3.3 并发与冲突

Web `GET` 和 SSE 负载都返回 `version`。Web `PUT` 请求体包含可选的 `version`：

- 版本匹配时接受更新并返回新快照。
- 版本不匹配时返回 `409`，响应包含服务端当前快照，客户端放弃本地提交并刷新显示。
- 未提供版本时按最后写入者胜出处理，供脚本和兼容客户端使用。

Agent 更新不因 Web 正在编辑而阻塞；它使用当前版本递增并广播，后到的合法更新成为新的会话状态。

## 4. 服务端 API 与实时事件

新增接口：

### `GET /api/sessions/:id/todos`

返回：

```json
{
  "todos": [],
  "version": 0
}
```

不存在的会话返回 `404`。

### `PUT /api/sessions/:id/todos`

请求体：

```json
{
  "todos": [
    { "id": "setup", "content": "准备环境", "status": "pending" }
  ],
  "version": 0
}
```

响应为更新后的完整快照。非法数据返回 `400`，版本冲突返回 `409`，不存在的会话返回 `404`。

### `GET /api/sessions/:id/todos/events`

使用 `text/event-stream`。建立连接时立即发送当前快照，后续更新发送：

```text
event: todo_updated
data: {"todos":[],"version":1,"source":"agent"}

```

连接关闭时移除订阅者。服务端只保存当前内存连接，不把连接本身写入会话。

### 现有会话接口

`GET /api/sessions/:id` 增加 `todos` 和 `todoVersion`，方便 Web 首次加载和其他客户端恢复。会话列表不重复返回完整任务内容，只保留现有摘要字段。

## 5. Agent 工具接入

`createTodoTool` 的更新回调允许同步或异步函数。服务端为每个会话创建一个绑定该会话的 `todo_write` 工具，并把它加入普通消息、计划执行和子 Agent 能看到的工具集合。

工具成功执行后等待会话保存完成，再向模型返回成功结果；校验失败只返回工具错误，不触发会话保存或广播。原有 TUI 工具行为保持不变，继续过滤 `todo_write` 的普通工具卡片。

## 6. TUI 人工编辑

### 命令

在 `parseSlashCommand` 和命令列表中加入：

- `/todo`：显示当前清单。
- `/todo add <content>`：新增 `pending` 项。
- `/todo start <id>`：将项设为 `in_progress`，并把其他进行中项设为 `pending`。
- `/todo pending <id>`：设为 `pending`。
- `/todo done <id>`：设为 `completed`。
- `/todo edit <id> <content>`：修改内容。
- `/todo delete <id>`：删除项。
- `/todo clear`：清空清单。

命令只修改 Todo，不启动 Agent turn；成功或错误以 notice 显示。ID 不存在、内容为空或命令参数不足时不改变旧列表。

### 快捷键编辑器

增加 `Ctrl+Shift+T` 打开 Todo 编辑器。编辑器支持方向键选择任务，`a` 新增、`e` 编辑内容、`s` 循环状态、`d` 删除，Enter 确认，Escape 取消。编辑器只在没有自动补全、没有等待权限且没有运行中的 Agent turn 时接管按键，避免覆盖现有快捷键和输入行为。

快捷键编辑器和 `/todo` 命令都通过纯函数生成新的完整快照，再 dispatch `SET_TODOS`；任何失败都保留原状态。

## 7. Web 页面

新增可维护的静态页面源码：

- `web/index.html`：页面骨架。
- `web/app.js`：会话选择、REST 初始加载、SSE 订阅、Todo 编辑和冲突处理。
- `web/styles.css`：紧凑的任务面板、状态颜色和移动端布局。

服务端通过 `express.static` 提供 `web` 目录的静态资源。页面从 URL 的 `session` 查询参数读取会话 ID；未提供时加载会话列表并选择最近的会话。页面提供会话选择、Todo 完成度、完整清单、添加/编辑/删除/状态切换/清空操作。

浏览器端以 `version` 作为乐观并发标记。收到 SSE 后直接替换本地快照；提交遇到 `409` 时显示冲突提示并采用服务端快照。SSE 断线时自动重连，并保留 REST 状态作为重连后的基线。

页面不接触 LLM 配置、API key 或其他服务端私密信息。

## 8. 错误处理与兼容性

- JSONL 中缺少新字段按默认值恢复。
- 单条损坏的历史 JSONL 记录继续按现有策略跳过。
- 非法 Todo 快照返回可读错误，不覆盖旧状态。
- Web 不存在的会话和版本冲突使用明确的 HTTP 状态码。
- SSE 客户端断开不影响 Agent、会话保存或其他订阅者。
- `/clear` 继续清空 TUI 当前 Todo，并保持现有显示设置。
- 不修改已有 `web/dist` 构建产物作为实现源码；新页面源码由服务端直接提供。

## 9. 测试策略

先写失败测试，再实现：

1. `test/todo.test.ts`：异步更新回调、规范化快照和错误不更新行为。
2. `test/session-store.test.ts`：Todo/version JSONL 往返、旧事件兼容、快照恢复。
3. `test/server.test.ts`：会话创建/恢复、Agent `todo_write` 持久化、Todo GET/PUT、错误和版本冲突。
4. 新增服务端 SSE 测试：初始快照、更新事件和连接关闭清理。
5. `test/tui-todo.test.ts` 及必要的 TUI 输入测试：命令解析、命令更新、快捷键入口和 reducer 保留旧状态。
6. 静态页面测试：页面资源可由服务端返回，并包含 Todo 面板入口。
7. 完成后运行 Todo/TUI/Session/Server 专项测试、类型检查和完整测试集。

## 10. 非目标

- 不引入数据库、WebSocket、跨进程事件总线或多用户权限系统。
- 不把 Todo 历史版本单独展示为审计日志；会话 JSONL 只承担恢复当前快照的职责。
- 不把 TUI 改造成 Web 客户端，也不改变已有 Agent 消息协议。
- 不扩展 Todo 字段为优先级、截止日期、依赖关系或富文本。
