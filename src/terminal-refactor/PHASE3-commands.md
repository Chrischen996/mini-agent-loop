# Phase 3: 命令系统扩展

## 目标
将 `slash-commands.ts` 扩展为完整 REPL 命令系统（类似 Claude Code 的 `/login`、`/goal`、`/artifacts`）。

## 当前状态
`slash-commands.ts` 只支持：`/read`、`/bash`、`/ls`、`/find`、`/grep`

## 扩展计划

### 1. 新增命令类型
```typescript
export type SlashCommand =
  | { cmd: "read"; path: string }
  | { cmd: "bash"; command: string }
  | { cmd: "ls"; path: string }
  | { cmd: "find"; pattern: string; path: string }
  | { cmd: "grep"; pattern: string; path: string }
  | { cmd: "login"; provider?: string }      // 新增
  | { cmd: "goal"; objective: string }        // 新增
  | { cmd: "artifacts"; action: "list" | "upload" | "delete"; id?: string } // 新增
  | { cmd: "model"; modelName?: string }      // 新增
  | { cmd: "profile"; action: "list" | "save" | "load"; name?: string } // 新增
  | null;
```

### 2. 新增解析逻辑
```typescript
case "login": return { cmd: "login", provider: parts[1] ?? "anthropic-compatible" };
case "goal": return { cmd: "goal", objective: parts.slice(1).join(" ") };
case "artifacts": return { cmd: "artifacts", action: (parts[1] as any) ?? "list", id: parts[2] };
case "model": return { cmd: "model", modelName: parts[1] };
case "profile": return { cmd: "profile", action: (parts[1] as any) ?? "list", name: parts[2] };
```

### 3. 在 `App.tsx` 中处理新命令
- `/login` → 打开交互式配置面板（类似 `pending-permission.ts` 扩展）
- `/goal` → 启动目标驱动模式（类似 `plan-commands.ts`）
- `/artifacts` → 管理 HTML 上传
- `/model` → 调用 `model-switcher.ts`
- `/profile` → 调用 `profile-manager.ts`

### 4. 新增文件
- `src/tui/commands/login-command.ts`
- `src/tui/commands/goal-command.ts`
- `src/tui/commands/artifacts-command.ts`

## 验证
```bash
# 测试解析
node -e "const {parseSlashCommand} = require('./src/tui/slash-commands.ts'); console.log(parseSlashCommand('/login openrouter'))"
```
