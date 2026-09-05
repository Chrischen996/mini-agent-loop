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

## 4. 风险与改进建议

1. **巨型文件**：`server.ts` 2862 行、`loop.ts` 1611 行、`tui/App.tsx` 1288 行、
   `subagent/tool.ts` 1236 行。建议按路由域拆分 server（sessions / plans / jobs / git），
   loop 抽出「思考策略」「计划阶段」「工具执行」子模块。
2. **供应商模型目录硬编码**：`src/pi-ai/providers/*.models.ts` 合计上万行常量（openrouter 4897 行），
   与代码一起演进会频繁产生噪音 diff。建议改为构建期生成的 JSON 数据资产 + 生成脚本。
3. **`src/pi-ai` 与依赖 `@earendil-works/pi-ai` 并存**：存在 vendor 分叉/重复维护的嫌疑，
   需要明确边界（是补丁层还是完整复制），否则升级依赖时容易冲突。
4. **CHANGELOG / README 与代码定位不同步的历史包袱**：README 30KB，仍混有"教学 loop"叙事；
   建议拆成 `README`（快速上手）+ `docs/architecture.md` + `docs/api.md`。
5. **CI 只有 publish**：`.github/workflows` 缺少 PR 触发的 test/typecheck 流水线，
   建议补一个 `ci.yml` 跑 `pnpm test` + `typecheck`。
6. **git 历史被压平**：当前克隆只有 1 个 commit，无法做变更溯源；若是 squash 发布仓库，
   建议保留开发历史或在 CHANGELOG 中细化。
7. **安全面**：bash 工具 + Docker/Node 沙箱 + MCP 外部服务共存，建议在文档中明确默认权限矩阵
   （哪些工具默认需要审批），并对 `web-access`/MCP 的出网做可配置白名单。

## 5. 一句话结论

这是一个**结构清晰、功能完成度远超"mini"命名**的 Agent 运行时：内核（loop + tools + permissions）
设计规范、测试扎实；主要债务集中在**超大文件、硬编码模型目录、vendor 层边界与 CI 缺失**，
这几项处理后就是一个可长期维护的开源 Agent 框架。
