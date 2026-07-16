# Mini Tool Agent - Next Development Plan

## 目标

在已经完成 Phase 1-3 核心 agent loop、vision preprocessing、HTTP server 和 GUI 的基础上，继续提升真实可用性和对 Pi agent loop 的理解。

本计划不重新设计现有架构，优先稳定现有行为，再逐步加入流式输出、取消和并行工具。

## 当前基线

已完成：

- OpenAI-compatible Chat Completions 客户端
- 顺序 tool-call loop
- `read` 工具和 cwd/symlink 沙箱
- 参数解析、校验和工具错误消息
- `maxTurns` 防止无限循环
- DeepSeek 和基础模型能力注册
- 图片读取和 vision preprocessing
- Express API、多轮内存 session、NDJSON 事件流
- React/Vite GUI
- 离线测试 34 项全部通过
- TypeScript 类型检查通过
- LLM wire protocol、tool-call 映射和错误脱敏测试已补齐
- `read` 的 offset/limit、行数上限和 UTF-8 字节边界测试已补齐
- 生产前端构建已验证通过

当前未完成验证：

- 真实 OpenAI-compatible API 的完整多轮工具调用
- 真实 DeepSeek tool calling
- 真实 vision provider 调用
- 生产环境 server/GUI 的实际启动和端到端访问

## Phase 4 - 真实模型与协议稳定性

### 目标

证明核心 loop 在真实 API 下稳定工作，并固定 OpenAI-compatible wire protocol 的行为。

### 工作项

1. 使用真实 API 验证纯文本请求。
2. 验证模型返回 `tool_calls` 后，下一次请求包含：
   - assistant message
   - `tool_calls`
   - 对应的 tool result
3. 验证 `read package.json` 的真实多轮流程。
4. 验证 DeepSeek 配置、API key 选择和工具调用。
5. 为 `llm.ts` 增加 fetch mock 测试，覆盖：
   - 请求 URL、headers、body
   - tool definition 序列化
   - tool result 序列化
   - 非法 JSON tool arguments
   - HTTP 错误、网络错误、空响应
6. 为 `read` 增加截断、offset、limit 和 UTF-8 边界测试。

### 验收标准

- 真实模型可以完成“读取 package.json 并总结项目名”。
- 所有新增协议测试离线通过。
- API key、请求体和图片 base64 不会出现在 GUI 响应或日志中。
- 真实 API 失败时 CLI 和 server 都返回可理解的错误。

## Phase 5 - Streaming 输出

### 目标

让 CLI 和 GUI 能够看到模型文本、工具调用和工具结果的实时进度。

### 设计约束

- 保留当前 `ChatFn`，新增独立的 streaming chat 接口。
- 不修改现有非流式 loop 的返回值和测试行为。
- 工具仍然按顺序执行。
- 每个事件必须包含可识别的 turn 或 message 信息。

### 建议事件

```ts
type StreamEvent =
  | { type: "assistant_delta"; text: string }
  | { type: "assistant_done"; message: AssistantMessage }
  | { type: "tool_start"; call: ToolCall }
  | { type: "tool_end"; call: ToolCall; result: ToolResult }
  | { type: "done" }
  | { type: "error"; message: string };
```

### 工作项

1. 解析 SSE 或 OpenAI-compatible streaming response。
2. 聚合 assistant 文本 delta。
3. 聚合分片 tool-call id、name 和 arguments。
4. 在完整 tool-call 生成后执行工具。
5. CLI 将进度写入 stderr，最终答案写入 stdout。
6. GUI 将事件转换为现有 NDJSON 格式。

### 验收标准

- 非流式模式继续通过全部原有测试。
- 流式模式能显示文本增量和工具状态。
- 分片 tool arguments 拼接后仍能正确校验。
- 流式请求错误不会导致 server 进程崩溃。

## Phase 6 - Abort、超时与资源边界

### 目标

让用户可以停止长时间运行的模型请求或工具调用，并限制单次请求的资源消耗。

### 工作项

1. 将 `AbortSignal` 从 server/CLI 传入 loop、LLM 和 tool。
2. 为模型请求增加请求级 timeout。
3. 为 vision 请求保留现有 timeout 和 retry 行为。
4. 用户断开 HTTP 连接时取消对应 agent turn。
5. 限制：
   - 最大 prompt 大小
   - 最大图片数量和大小
   - 最大 tool result 大小
   - 最大 session message 数量
6. 区分用户取消、超时、网络错误和模型错误。

### 验收标准

- 取消请求后不会继续发起下一次 LLM 调用。
- 工具收到 abort signal 后能结束执行。
- 取消或超时后 session 状态仍然可读取。
- 限制触发时返回明确的错误类型和消息。

## Phase 7 - 并行工具批次

### 目标

在保持结果顺序和错误隔离的前提下，支持同一 assistant turn 中的独立工具并行执行。

### 设计约束

- 默认仍使用顺序模式，新增配置显式开启并行。
- 结果消息必须按照模型返回的 tool-call 顺序写回。
- 一个工具失败不能取消其他独立工具。
- 共享资源工具暂不并行，除非工具声明可并行。

### 工作项

1. 增加工具并行能力声明。
2. 使用 `Promise.allSettled` 执行可并行工具。
3. 将结果按 source order 写入 message history。
4. 增加并行耗时、顺序和失败隔离测试。
5. 在 CLI/GUI 中显示每个工具的独立状态。

### 验收标准

- 两个独立 read 调用可以并行执行。
- 下一次 LLM 调用看到的 tool result 顺序与 tool-call 顺序一致。
- 单个失败不会丢失其他成功结果。
- 默认配置行为保持顺序执行。

## Phase 8 - Session 持久化

### 目标

将当前内存 session 持久化到 JSONL，使 server 重启后可以恢复会话。

### 工作项

1. 定义 JSONL message/event 格式。
2. 增加 session repository 接口。
3. 实现文件存储，并限制存储目录。
4. 写入时使用临时文件或追加方式保证单条记录完整。
5. 启动时恢复 session 索引。
6. 增加损坏行、重复 session 和并发写入测试。

### 验收标准

- server 重启后可以继续已有 session。
- 单个损坏记录不会导致所有 session 无法加载。
- API key、图片原始 base64 和敏感配置不写入 session 文件。
- session 文件大小和数量有明确限制。

## 推荐执行顺序

1. Phase 4：真实模型验证和协议测试
2. Phase 5：streaming
3. Phase 6：abort、timeout 和资源限制
4. Phase 7：并行工具
5. Phase 8：JSONL session 持久化

每个阶段完成后都应运行：

```bash
npm test
npm run typecheck
npm run build
```

## 暂不做的功能

- 完整 TUI
- MCP 和 extension loader
- 多 provider registry
- 权限审批 UI
- session tree、fork、compact
- sub-agent 和队列编排

这些功能会显著扩大教学项目的范围，应在核心 loop、streaming、取消和持久化稳定后再单独立项。
