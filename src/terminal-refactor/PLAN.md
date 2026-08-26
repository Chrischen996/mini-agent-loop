# Claude Code TUI 终端重构开发计划

## 目标
将 mini-agent 的 TUI 终端改造成类似 Claude Code Best (CCB) 的工程化实现。

## 目标状态（Claude Code）
- 构建：`bun install` → `bun run build` → `dist/cli.js` + ~450 chunk
- 调试：`bun run dev:inspect` → `ws://localhost:8888` → VS Code attach
- 命令：`/login`、`/goal`、`/ultracode`、`/pipes`、`/voice` 完整 REPL
- 配置：交互式 `/login` 配置界面 + `~/.claude/` 配置目录
- 远程：Remote Control + Pipe IPC 多实例协作

## 当前状态（mini-agent）
- 构建：`node --import tsx` 直接跑源码
- 调试：无 inspect 支持
- 命令：`slash-commands.ts` 基础解析
- 配置：`profile-store.ts` + 环境变量

## 开发阶段

### Phase 1: 构建与打包（最优先）
- [ ] 创建 `build.ts` 打包脚本（类似 claude-code 的 vite build + code splitting）
- [ ] 更新 `package.json` 脚本（`dev`, `build`, `dev:inspect`）
- [ ] 创建 `dist/` 输出结构

### Phase 2: 调试支持
- [ ] 在 `ink-main.tsx` 增加 `--inspect` / `--inspect-brk` 支持
- [ ] 更新 `package.json` 增加 `dev:inspect` 脚本
- [ ] 测试 VS Code attach 调试

### Phase 3: 命令系统扩展
- [ ] 扩展 `slash-commands.ts` 为完整 REPL 命令系统
- [ ] 实现 `/login` 交互式配置界面
- [ ] 实现 `/goal` 目标驱动功能
- [ ] 实现 `/artifacts` HTML 上传（可选）

### Phase 4: 配置系统
- [ ] 创建 `~/.mini-agent/` 配置目录支持
- [ ] 实现交互式配置面板
- [ ] 增加配置持久化

### Phase 5: 高级特性（可选）
- [ ] 远程控制支持
- [ ] 多实例 Pipe IPC
- [ ] 语音输入 `/voice`

## 文件结构
```
src/terminal-refactor/
├── PLAN.md                    # 本计划文档
├── PHASE1-build.md            # Phase 1 详细设计
├── PHASE2-inspect.md          # Phase 2 详细设计
├── PHASE3-commands.md         # Phase 3 详细设计
└── PHASE4-config.md           # Phase 4 详细设计
```
