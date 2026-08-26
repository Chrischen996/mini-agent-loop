# Phase 1: 构建与打包

## 目标
让 mini-agent 能够通过 `bun run build` 生成 `dist/cli.js` + chunk 文件，支持 `ccb` 全局命令。

## 当前状态
- `package.json` 的 `build` 脚本：`npm run typecheck`（只做类型检查）
- `build:package`：`tsc -p tsconfig.publish.json`（TypeScript 编译，不支持 code splitting）
- 无 `bun` 相关脚本

## 设计

### 1. 新增 `build.ts` 打包脚本
```typescript
// build.ts
import { build } from "vite";
import { nodeResolve } from "@vitejs/plugin-node";
import { builtinModules } from "module";

await build({
  configFile: false,
  logLevel: "info",
  build: {
    target: "node22",
    outDir: "dist",
    chunkSizeLimit: 100000,
    rollupOptions: {
      input: "src/tui/ink-main.tsx",
      output: {
        entryFileNames: "cli.js",
        chunkFileNames: "[name]-[hash].js",
        format: "esm",
        preserveModules: false,
      },
      external: [
        "react",
        "react-dom",
        "ink",
        ...builtinModules,
      ],
    },
    minify: process.env.NODE_ENV === "production",
  },
  plugins: [
    nodeResolve({ preferBuiltins: true }),
  ],
});
```

### 2. 更新 `package.json` 脚本
```json
{
  "scripts": {
    "dev": "tsx watch src/tui/ink-main.tsx",
    "build": "tsx build.ts",
    "build:package": "tsx build.ts",
    "dev:inspect": "node --inspect=0.0.0.0:8888 --import tsx src/tui/ink-main.tsx",
    "tui": "tsx src/tui/ink-main.tsx"
  }
}
```

### 3. 新增 `vite.config.ts`
```typescript
// vite.config.ts
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "node22",
    outDir: "dist",
    chunkSizeLimit: 100000,
    rollupOptions: {
      input: "src/tui/ink-main.tsx",
      output: {
        entryFileNames: "cli.js",
        chunkFileNames: "[name]-[hash].js",
        format: "esm",
      },
    },
  },
});
```

### 4. 安装依赖
```bash
npm install --save-dev vite @vitejs/plugin-node
```

## 验证
```bash
bun run build
# 输出 dist/cli.js + chunk 文件
node dist/cli.js --help
```