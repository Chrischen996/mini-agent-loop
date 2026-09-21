# Phase 2: 调试支持（Inspect）

## 目标
让 mini-agent TUI 支持 VS Code / Chrome DevTools 调试。

## 实现

### 1. 修改 `ink-main.tsx`
```typescript
// Parse command line arguments for debugging/inspection
const args = process.argv.slice(2);
const inspectArg = args.find(arg => arg.startsWith("--inspect"));
const inspectPort = inspectArg?.includes("=") ? inspectArg.split("=")[1] : "9222";

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  process.stderr.write("Hermes TUI requires an interactive terminal\n");
  process.exit(1);
}

async function main(): Promise<void> {
  // Start Node.js inspector if requested
  if (inspectArg) {
    const inspector = await import("node:inspector");
    inspector.open(Number(inspectPort), "127.0.0.1", false);
    console.error(`[inspector] started on port ${inspectPort}`);
  }
  // ... rest of the code
}
```

### 2. 更新 `package.json`
```json
{
  "scripts": {
    "tui:inspect": "tsx src/tui/ink-main.tsx --inspect=9229",
    "tui:inspect-brk": "tsx src/tui/ink-main.tsx --inspect-brk=9229"
  }
}
```

### 3. VS Code 调试配置（`.vscode/launch.json`）
```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "attach",
      "name": "Attach to TUI",
      "port": 9229,
      "restart": true,
      "sourceMaps": true,
      "localRoot": "${workspaceFolder}",
      "remoteRoot": "${workspaceFolder}"
    }
  ]
}
```

### 4. 使用方式
```bash
# 终端 1: 启动调试模式
npm run tui:inspect

# 终端 2: VS Code F5 → 选择 "Attach to TUI"

# 或在 VS Code 内置终端直接
npm run tui:inspect
# 然后 VS Code "Attach to Bun" / "Attach to Node"
```

### 5. 支持的命令行参数
- `--inspect` - 启动调试器，端口 9229
- `--inspect=PORT` - 启动调试器，指定端口
- `--inspect-brk` - 启动调试器并在首行断点

## 验证
```bash
npm run tui:inspect
# 输出: [inspector] started on port 9229
# 然后 VS Code Attach 即可
```
