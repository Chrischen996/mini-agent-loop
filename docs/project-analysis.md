# mini-agent-loop 项目分析

> 分析对象：`Chrischen996/mini-agent-loop`（分支 `feature/claude-code-terminal`，HEAD `8268ea0`）
> 规模：`src/` 约 327 个 TS/TSX 文件、约 7.5 万行；`test/` 约 100 个测试文件。

## 1. 项目定位

包名 `@krischen99999/mini-agent-loop`，自我定位为「可扩展的 AI Agent 运行时」，
面向三种载体：**CLI**（`dist/cli.js`）、**终端 TUI**（Ink，Claude Code 风格）、
**HTTP 服务**（Express）。名字里的 "mini loop" 只是内核，实际已经是一个较完整的
Agent 产品骨架。

核心循环仍是经典形态：

```
user prompt -> LLM -> tool_calls -> 逐个校验/执行 -> 回填 tool 结果 -> 再次 LLM -> 无 tool_calls 即停止
```

## 2. 架构分层

| 层 | 目录 | 说明 |
|---|---|---|
| 入口 | `src/cli.ts` (1023行), `src/server.ts` (2862行), `src/tui/*` | 三个前端共享同一运行时 |
| 核心循环 | `src/loop.ts` (1611行) | `runAgentLoop` / `runAgentTurn`、系统提示、权限模式、思考强度、压缩、Plan-Act、审计 |
| 模型接入 | `src/llm/*`, `src/pi-ai/*`, `src/models.ts` | 流式、重试、恢复、超时、视觉；`pi-ai` 内含 OpenAI/Anthropic/Bedrock/Codex-Responses 等 API 适配与巨量模型目录 |
| 工具 | `src/tools/*` | bash、read、write、edit、grep/find/ls、patch/move/copy/delete、git_*、validate_workspace、TodoWrite、document_edit |
| 扩展能力 | `src/skills`, `src/mcp`, `src/subagent`, `src/codebase`, `src/web-access`, `src/sandbox`, `src/memory` | 技能渐进加载、MCP 客户端与审批、子代理与成本核算、DeepWiki 代码库检索、Docker/Node 沙箱、自动记忆 |
| 会话与编排 | `src/session-*`, `src/orchestration/*`, `src/plan-act/*` | 会话持久化/fork/rewind/树、任务 Job 队列与暂停门、计划状态机 |
| 运行时约束 | `src/runtime/*`, `src/permissions.ts` | 工具执行 broker、限额、策略类型、权限请求 |

## 3. 亮点

- **多前端单内核**：CLI / TUI / HTTP 复用同一 loop 与 session manager，避免逻辑分叉。
- **产品级 Agent 特性齐全**：权限模式（含运行中切换抛 `PermissionModeChangedError`）、
  Plan-Act 两阶段审批、子代理委派、Todo、上下文压缩、断点续跑、Git checkpoint/undo。
- **工具执行经过 broker**：统一审计事件、参数 schema 校验（`validate.ts`）、AbortSignal 传递，
  各工具都实现了中断检查，这在同类玩具项目里少见。
- **HTTP API 面很宽**：sessions/plans/permissions/jobs/memory/git/models/subagent-profiles 全套 REST，
  可作为 Web IDE 后端。
- **测试覆盖面广**：约 100 个 `node:test` 测试文件，TUI 渲染模型、流式缓冲、权限、计划、沙箱都有覆盖，
  另配 c8 覆盖率与 `tsc --noEmit` 类型检查。
- **发布链路完整**：`build.ts` 打包、npm publish GitHub Action（tag 触发并校验版本一致）。

## 4. 风险与改进建议（含处理状态）

| # | 问题 | 状态 | 处理方式 |
|---|---|---|---|
| 1 | 巨型文件（server.ts 2862 行等） | ✅ 部分完成 | `server.ts` 拆到 2091 行，11 个路由域移入 `src/server/routes/*`，每个模块只接收窄化的 context。剩余 `loop.ts` / `App.tsx` / `subagent/tool.ts` 未拆 |
| 2 | 模型目录硬编码上万行 | ✅ 完成 | 1080 个模型抽成 `src/pi-ai/providers/data/*.json`；补上了文件头一直声称却不存在的 `scripts/generate-models.ts`；`npm run generate-models[:check]` |
| 3 | `src/pi-ai` 与 npm 依赖边界不清 | ✅ 完成 | 查明 `pi-agent-core` / `pi-ai` / `pi-coding-agent` **从未被 import**，已从 dependencies 移除（仅 `pi-tui` 真实使用）；新增 `src/pi-ai/README.md` 说明这是完整 vendor fork |
| 4 | README 30KB 混杂、Layout 严重过期 | ✅ 完成 | 新增 `docs/architecture.md`（真实目录图 + 路由模块表），README Layout 替换为摘要 + 链接 |
| 5 | CI 只有 publish | ✅ 完成 | 新增 `.github/workflows/ci.yml`：PR 上跑 typecheck / test / 目录漂移检查 / build |
| 6 | git 历史被压平 | ⚠️ 未处理 | 属于仓库发布策略，代码层面无法修复 |
| 7 | 安全面（bash + 沙箱 + MCP）缺文档 | ✅ 完成 | 新增 `docs/security-model.md`：逐工具 × 三种权限模式的默认矩阵、MCP 永不按名信任、沙箱默认值、三条出网路径与「缺少全局白名单」的明确声明 |

顺带修掉的既有缺陷（CI 要能真正卡住就必须先修）：

- `tsc --noEmit` 原有 2 个错误 → 0（Bedrock 中间件类型、缺失的 `src/tui/inspect.ts`）
- 测试 1055/1058 → **1064/1064**
  - `resolveTerminalDisplayMode` 声称接受注入的 `env`，却仍读全局 `process.stdin.isTTY`，结果随启动方式漂移 → 改为纯函数并补非交互终端用例
  - `extractFileAcTrigger` 丢失了裸词文件补全
  - `test/tui-inspect.test.ts` 引用了不存在的模块

## 5. 一句话结论

这是一个**结构清晰、功能完成度远超"mini"命名**的 Agent 运行时：内核（loop + tools + permissions）
设计规范、测试扎实；主要债务集中在**超大文件、硬编码模型目录、vendor 层边界与 CI 缺失**，
这几项处理后就是一个可长期维护的开源 Agent 框架。
