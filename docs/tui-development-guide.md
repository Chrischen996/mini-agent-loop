# TUI 终端开发文档

> 本文档描述 mini-agent-loop 项目的 TUI（终端用户界面）架构、核心组件和开发指南。

---

## 目录

1. [系统概述](#1-系统概述)
2. [架构设计](#2-架构设计)
3. [核心组件](#3-核心组件)
4. [状态管理](#4-状态管理)
5. [输入处理](#5-输入处理)
6. [布局系统](#6-布局系统)
7. [渲染管线](#7-渲染管线)
8. [快捷键系统](#8-快捷键系统)
9. [自动补全](#9-自动补全)
10. [开发指南](#10-开发指南)

---

## 1. 系统概述

### 1.1 技术栈

- **框架**: [Ink](https://github.com/vadimdemedes/ink) - React for CLIs
- **语言**: TypeScript
- **终端模拟**: 支持 xterm、iTerm2、VS Code Terminal 等现代终端
- **输入法**: 支持 CJK IME（基于 grapheme 分割）

### 1.2 核心特性

- 实时流式输出（streaming）
- 多行输入编辑
- 键盘导航（光标、历史、分页）
- 自动补全（命令、文件、模型、会话）
- 权限确认面板
- Todo 面板
- 计划审批流程
- 多智能体协作界面

### 1.3 目录结构

```
src/tui/
├── App.tsx                          # 主应用组件
├── state.ts                         # Redux 风格状态管理
├── layout.ts                        # 视口高度计算
├── terminal-render-model.ts         # 渲染模型构建
├── incremental-renderer.ts          # 增量渲染器
├── components/
│   ├── PromptInput.tsx              # 输入框组件
│   ├── MessageFeed.tsx              # 消息流组件
│   ├── Overlays.tsx                 # 覆盖层组件
│   └── ...                          # 其他 UI 组件
├── hooks/
│   ├── useKeyboardHandler.ts        # 键盘快捷键钩子
│   └── useAutocomplete.ts           # 自动补全钩子
├── terminal-input-controller.ts     # 原始输入控制器
├── terminal-autocomplete-controller.ts # 自动补全控制器
└── theme.ts                         # 颜色主题
```

---

## 2. 架构设计

### 2.1 数据流

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│   用户输入   │────▶│ InputHandler │────▶│   State     │
└─────────────┘     └──────────────┘     └──────┬──────┘
                                                │
                   ┌────────────────────────────┘
                   │ dispatch(action)
                   ▼
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│  Reducer    │────▶│   State      │────▶│  Renderer   │
└─────────────┘     └──────────────┘     └──────┬──────┘
                                                │
                   ┌────────────────────────────┘
                   │ update visual
                   ▼
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│  Ink Render │────▶│ Terminal API │────▶│  Screen     │
└─────────────┘     └──────────────┘     └─────────────┘
```

### 2.2 核心模块关系

```
                    ┌─────────────────┐
                    │      App.tsx    │
                    └────────┬────────┘
                             │
           ┌─────────────────┼─────────────────┐
           │                 │                 │
           ▼                 ▼                 ▼
    ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
    │  MessageFeed│  │ PromptInput │  │  Overlays   │
    │   (消息流)   │  │  (输入框)   │  │  (覆盖层)   │
    └──────┬──────┘  └──────┬──────┘  └──────┬──────┘
           │                │                │
           └────────────────┼────────────────┘
                            │
                     ┌──────▼──────┐
                     │   State     │
                     │  (全局状态)  │
                     └─────────────┘
```

---

## 3. 核心组件

### 3.1 App.tsx - 主应用组件

**职责**: 协调所有子组件，管理应用生命周期

```typescript
export function App({ cwd, agentTools, allTools, mcpStatuses }: AppProps): React.ReactElement {
  // 状态管理
  const [state, dispatch] = useReducer(tuiReducer, createInitialState(llm.model));
  
  // 渲染逻辑
  return (
    <Box flexDirection="column" width={termWidth} height={frameHeight} overflow="hidden">
      {/* 头部 */}
      {hasHeader && <Header ... />}
      
      {/* 消息流 */}
      <MessageFeed ... />
      
      {/* 覆盖层（补全、权限等） */}
      <Overlays ... />
      
      {/* 底部面板 */}
      <TodoPanel ... />
      <PermissionPanel ... />
      
      {/* 输入框 */}
      <PromptInput ... />
    </Box>
  );
}
```

### 3.2 PromptInput.tsx - 输入框组件

**关键特性**:
- 图符安全的光标管理
- 多行输入支持
- 历史记录导航
- 附件显示

```typescript
export type PromptInputProps = {
  value: string;                    // 当前输入值
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onTab?: (value: string) => void;
  onPasteImage?: () => unknown | Promise<unknown>;
  pasteEnabled?: boolean;
  focus?: boolean;                  // 是否获得焦点
  mask?: string;                    // 密码掩码字符
  placeholder?: string;
  attachments?: string[];
  inputHistory?: TerminalInputHistory;
  disableArrowNavigation?: boolean;
  onScrollContext?: (direction: "up" | "down") => void;
};
```

**渲染逻辑**:

```tsx
<Box flexDirection="column" flexGrow={1} minWidth={0}>
  {/* 图片附件显示 */}
  {attachments && attachments.length > 0 && (
    <Box flexDirection="row" flexWrap="wrap">
      {attachments.map((_, i) => (
        <Text key={`img-${i}`} color="cyan">[Image #{i + 1}] </Text>
      ))}
    </Box>
  )}
  {/* 输入内容 */}
  <PromptLines parts={displayParts} cursor={safeCursor} focus={focus} placeholder={placeholder} />
</Box>
```

### 3.3 MessageFeed.tsx - 消息流组件

**职责**: 渲染对话历史和流式响应

```typescript
export function MessageFeed({
  messages,
  streamingText,
  streamingReasoning,
  thinkingMode,
  expandedThinking,
  focusedMessageIndex,
  busy,
  status,
  pendingPermission,
  turnStartedAt,
  lastStreamAt,
  spinnerMessage,
  todoPanelVisible,
  availableHeight,
  width,
  scrollOffset,
  showHistoryHints,
  heightCache,
  subagentById,
  subagentRevision,
  subagentChange,
  toolById,
  toolRevision,
  toolChange,
  activeToolId,
}: MessageFeedProps): React.ReactElement {
  // 视口管理逻辑...
}
```

---

## 4. 状态管理

### 4.1 状态树结构

```typescript
export type TuiState = {
  // 消息相关
  messages: AgentMessage[];
  streamingText: string;
  streamingReasoning: string;
  focusedMessageIndex: number;
  scrollOffset: number;
  maxScrollOffset: number;
  
  // 输入相关
  input: string;
  busy: boolean;
  status: string;
  
  // 权限相关
  pendingPermission?: PendingPermission;
  
  // Todo 相关
  todoItems?: TodoItem[];
  todoPlan?: Plan;
  todoViewMode: TodoViewMode;
  
  // 任务相关
  taskTitle: string;
  taskStatus: TaskStatus;
  taskDurationMs: number;
  taskTokens: number;
  
  // 子智能体相关
  subagentById: Record<string, SubagentState>;
  subagentRevision: number;
  subagentChange: number;
  
  // 工具相关
  toolById: Record<string, ToolState>;
  toolRevision: number;
  toolChange: number;
  
  // 思考模式
  thinkingMode: "off" | "on" | "adaptive";
  expandedThinking: boolean;
  
  // 阶段
  phase: "idle" | "running" | "review";
  currentPlan?: Plan;
  
  // 队列
  queuedCount: number;
};
```

### 4.2 动作类型

```typescript
export type TuiAction =
  | { type: "LOOP_EVENT"; event: LoopEvent }
  | { type: "SET_INPUT"; value: string }
  | { type: "SUBMIT_INPUT"; value: string }
  | { type: "SCROLL_BY"; delta: number }
  | { type: "SCROLL_TO_BOTTOM" }
  | { type: "SET_MAX_SCROLL_OFFSET"; offset: number }
  | { type: "SET_FOCUSED_MESSAGE"; index: number }
  | { type: "TOGGLE_THINKING_MODE" }
  | { type: "TOGGLE_MESSAGE_THINKING" }
  | { type: "FOCUS_NEXT_REASONING"; direction: -1 | 1 }
  | { type: "CANCEL_GENERATION" }
  | { type: "SET_PENDING_PERMISSION"; permission: PendingPermission }
  | { type: "CLEAR_PENDING_PERMISSION" }
  | { type: "SET_PERMISSION_MODE"; mode: string }
  | { type: "SET_TODO_PLAN"; plan?: Plan }
  | { type: "SET_TODO_ITEMS"; items: TodoItem[] }
  | { type: "SET_TASK_SUMMARY"; summary: TaskSummary }
  | { type: "SET_QUEUED_COUNT"; count: number }
  // ... 更多
```

### 4.3 Reducer 模式

使用 Redux 风格的 reducer 进行状态管理：

```typescript
export function tuiReducer(state: TuiState, action: TuiAction): TuiState {
  switch (action.type) {
    case "LOOP_EVENT":
      return handleLoopEvent(state, action.event);
    case "SET_INPUT":
      return { ...state, input: action.value };
    case "SCROLL_BY":
      return {
        ...state,
        scrollOffset: Math.max(0, Math.min(state.maxScrollOffset, state.scrollOffset + action.delta)),
      };
    // ...
    default:
      return state;
  }
}
```

---

## 5. 输入处理

### 5.1 输入控制器架构

```
┌─────────────────────────────────────────────────────────┐
│                    TerminalInputController               │
├─────────────────────────────────────────────────────────┤
│  解析原始 stdin 数据                                      │
│  ├─ 普通字符 → insert                                    │
│  ├─ Ctrl+C → exit                                        │
│  ├─ Enter → submit                                       │
│  ├─ Arrow keys → cursor/navigation                      │
│  ├─ ESC → cancel                                         │
│  └─ SGR 鼠标序列 → scroll                               │
└─────────────────────────────────────────────────────────┘
                           │
                           ▼ emit(action)
┌─────────────────────────────────────────────────────────┐
│                    useInput Hook                         │
│  Ink 框架的键盘事件处理器                                 │
└─────────────────────────────────────────────────────────┘
```

### 5.2 图符安全处理

使用 `Intl.Segmenter` 进行图符分割：

```typescript
const graphemeSegmenter = typeof Intl !== "undefined" && "Segmenter" in Intl
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : undefined;

function graphemes(value: string): string[] {
  if (_graphemeSegmenter) {
    return [..._graphemeSegmenter.segment(value)].map((part) => part.segment);
  }
  return [...value];
}
```

### 5.3 光标管理

```typescript
function clampCursor(index: number, count: number): number {
  return Math.max(0, Math.min(index, count));
}

function insertAt(parts: string[], cursor: number, text: string): { next: string; cursor: number } {
  const inserted = splitGraphemes(text);
  const nextParts = [...parts.slice(0, cursor), ...inserted, ...parts.slice(cursor)];
  return { next: joinGraphemes(nextParts), cursor: cursor + inserted.length };
}

function deleteBefore(parts: string[], cursor: number): { next: string; cursor: number } {
  if (cursor <= 0) return { next: joinGraphemes(parts), cursor };
  const nextParts = [...parts.slice(0, cursor - 1), ...parts.slice(cursor)];
  return { next: joinGraphemes(nextParts), cursor: cursor - 1 };
}
```

---

## 6. 布局系统

### 6.1 视口计算

```typescript
export function getTuiViewportHeight(termRows: number | undefined): number {
  return Math.max(1, (termRows ?? 24) - 1);
}

export function getMessageFeedHeight(options: {
  termRows: number | undefined;
  hasHeader?: boolean;
  headerRows?: number;
  hasPendingImages?: boolean;
  todoRows?: number;
  pickerRows?: number;
  permissionRows?: number;
  planApprovalRows?: number;
  updateRows?: number;
}): number {
  const viewport = getTuiViewportHeight(options.termRows);
  const chrome =
    (options.hasHeader === false ? 0 : options.headerRows ?? TUI_BRAND_HEADER_HEIGHT) +
    2 + // input row
    1 + // stable status row
    (options.hasPendingImages ? 1 : 0) +
    (options.todoRows ?? 0) +
    (options.pickerRows ?? 0) +
    (options.permissionRows ?? 0) +
    (options.planApprovalRows ?? 0) +
    (options.updateRows ?? 0);
  return Math.max(3, viewport - chrome);
}
```

### 6.2 布局约束

```typescript
// App.tsx 中的布局计算
const termWidth = Math.max(10, stdout?.columns || 80);
const termHeight = Math.max(1, (stdout?.rows || 24) - 2);

// 计算自然帧高度
const fixedChromeRows =
  (hasHeader ? headerRows : 0) +
  bottomPanelRows +
  pickerLayout.totalRows +
  permissionRows +
  planApprovalRows +
  (state.pendingImages.length > 0 ? 1 : 0) +
  updateRows +
  2; // prompt + stable status row

const naturalFrameHeight = Math.max(
  1,
  fixedChromeRows + Math.min(viewportActualHeight, feedHeight),
);
const frameHeight = Math.min(termHeight, naturalFrameHeight);
```

---

## 7. 渲染管线

### 7.1 增量渲染器

```typescript
export class IncrementalTerminalRenderer {
  private previousLines: string[] | undefined;

  constructor(private readonly target: WriteStream) {}

  write(data: string): boolean {
    const frame = extractInkFrame(data);
    if (frame === undefined) {
      this.target.write(data);
      return true;
    }

    const nextLines = frame.split("\n");
    if (nextLines.at(-1) === "") nextLines.pop();
    this.renderLines(nextLines.map((text, index) => ({ key: `ink-${index}`, text, style: "assistant" as const })));
    return true;
  }

  private renderRows(nextLines: string[]): void {
    const previous = this.previousLines ?? [];
    let output = "";

    for (let index = 0; index < nextLines.length; index++) {
      if (nextLines[index] === previous[index]) continue;
      output += `\x1b[${index + 1};1H${ANSI_ERASE_LINE}${nextLines[index] ?? ""}`;
    }
    // 清除多余行...
    
    if (output) {
      output += `\x1b[${Math.max(1, nextLines.length)};1H`;
      this.target.write(output);
    }
    this.previousLines = nextLines;
  }
}
```

### 7.2 渲染模型构建

```typescript
export function buildTerminalRenderLines(
  state: TuiState,
  options: TerminalRenderOptions = {},
): RenderLine[] {
  const lines: RenderLine[] = [];
  
  // 1. 构建头部
  const header = options.header?.show === false ? [] : options.header ? headerRenderLines(state, options.header, width) : [];
  lines.push(...header);
  
  // 2. 渲染消息
  for (let index = messageStart; index < state.messages.length; index++) {
    const message = resolveTranscriptMessage(state.messages[index]!, ...);
    // 根据消息类型渲染不同行
  }
  
  // 3. 渲染底部面板
  const taskSummaryLines = showTaskSummary ? taskSummaryRenderLines(...) : [];
  const panelLines = todoPanelRenderLines(...);
  
  // 4. 渲染输入行
  if (options.input !== undefined) {
    lines.push({ key: "input", text: options.input, prefix: "❯ ", style: "user" });
  }
  
  return lines;
}
```

### 7.3 布局模式与静态分流（inline / document / alternate）

终端布局由环境变量 `MINI_AGENT_TUI_LAYOUT` 在启动时选择（`src/tui/layout-mode.ts`）：

- **`document`（默认）**：完全文档流（aider / Codex insert 风格）——没有任何钉住的区域，也没有截断提示。流式回复的**每一行源码在换行到达时立即追加**进终端流（`src/tui/stream-commit.ts` 的 `computeCommitBoundary`：段落/标题/列表/代码块全部逐行稳定——代码行渲染为固定 `│` gutter 行，唯未闭合的表格因列宽需全局对齐而扣住，由后随行闭合时整体冻结），动态帧只剩"正在长的那一行 + 输入框"，因此滚轮上下滚动时**整个对话（包括输入框所在位置）作为一个连续文档一起移动**。消息定型时用最长公共行前缀去重（`rowCountledCommitted`），已流出的行不会在 seal 时重复打印。流式文本在 document 模式下直接渲染完整 markdown 投影（`streamingAssistantRows`），不再是压缩预览。
- **`inline`（消息级，`MINI_AGENT_TUI_LAYOUT=inline`）**：UI 运行在主屏幕缓冲。已"定型"的会话前缀（user / assistant / notice / error / 已完成的 tool_call；subagent 卡片永远保持动态）通过渲染器的 `emitStaticBurst()` 直接写入终端**原生 scrollback**——滚轮/搜索/复制走终端原生能力，退出后历史保留。鼠标跟踪关闭以让滚轮自然滚动 scrollback。流式中的消息暂存于动态帧窗口。
- **`alternate`（备选/回退）**：整 UI 运行在备用屏幕缓冲（`ESC[?1049h`），退出后不污染 shell 滚屏历史；鼠标跟踪开启，滚轮/PageUp 在应用内滚动历史。用 `MINI_AGENT_TUI_LAYOUT=alternate` 一键回退。

静态分流与 burst 通道强绑定：宿主未提供 `writeStaticBurst`（如测试直接渲染 `App`）时自动退回“全部动态渲染”，不会丢行。

关键机制：

- 渲染器（`IncrementalTerminalRenderer`）在 inline / document 模式下维护只向下移动的帧锚点 `frameTopRow`：静态突发写在锚点处并推进锚点，动态帧从锚点向下重绘；帧超出屏幕底部时先在底行发出差额滚动（deficit scroll），把先前内容推入 scrollback 再重绘。document 模式复用同一锚点管线，只是帧内容缩小为“未提交尾部 + chrome”，帧根不再固定为整屏高（`height=undefined`）。
- 静态突发由 App 在 layout effect 中发射（`writeStaticBurst` prop → `emitStaticBurst`），绕过 Ink 的写入管线——Ink 的 log-update 给每个动态帧追加尾随换行，使得按写入形状分类静态/动态不可靠。发射位置按会话代际（transcript generation）追踪：数组追加式增长沿用，RESET / 恢复会话 / 回滚则从头重发。
- 定型行的视口排除由 `selectMessageViewport({ historyStartIndex })` 完成：滚动核算、history hint 与渲染都只覆盖未定型尾部，行级缓存在定型/动态两侧共享，滚动簿记不再计入已进入 scrollback 的行。
- 慢帧/闪烁监控（`src/tui/perf-monitor.ts`）：渲染器逐帧上报耗时与重绘行；`MINI_AGENT_SLOW_FRAME_MS`（默认 200）定义慢帧阈值，同一物理行 1 秒内重绘 ≥12 次记为闪烁嫌疑；`MINI_AGENT_RENDER_STATS=1` 在进程退出时向 stderr 打印汇总。
- 字符串宽度缓存（`terminal-width.ts`）：grapheme 级与整行级双层记忆化，CJK/emoji 场景每帧宽度计算从 O(字符) 降为查表；缓存有界（超限整体清空），`clearTerminalWidthCaches()` 供测试使用。

---

## 8. 快捷键系统

### 8.1 全局快捷键

| 快捷键 | 功能 |
|--------|------|
| `Ctrl+C` | 中止并退出 |
| `ESC` (busy 时) | 取消 LLM 生成 |
| `Ctrl+Y` / `Ctrl+Shift+C` | 复制文本 |
| `Ctrl+V` | 粘贴图片 |
| `Shift+Tab` | 切换权限模式 |
| `Ctrl+T` | 切换思考模式 |
| `Alt+T` | 切换消息思考 |
| `Alt+↑/↓` | 在思考消息间导航 |
| `↑` / `↓` | 向上/向下滚动 transcript（多行输入时先移动光标） |
| `PageUp` / `PageDown` | 按页滚动 transcript |
| `Ctrl+↑` / `Ctrl+↓` | 按单行滚动 transcript |
| `Ctrl+G` | 滚动到底部 |
| `Ctrl+Shift+T` | 打开 Todo 编辑器 |

### 8.2 输入框快捷键

| 快捷键 | 功能 |
|--------|------|
| `Ctrl+P` / `Ctrl+N`（或 `Cmd+P` / `Cmd+N`） | 召回上一条/下一条已提交的 prompt，并保留当前草稿 |
| `↑` / `↓` | 滚动 transcript；多行输入时先移动文本光标 |
| `←` / `→` | 光标移动 |
| `Ctrl+←` / `Ctrl+→` | 词级导航 |
| `Home` / `End` | 跳转行首/行尾 |
| `Enter` | 空闲时提交；忙碌时排队，等待任务结果时可立即发送 |
| 忙碌时再次按空 `Enter` | 立即发送队首消息并取消当前轮次 |
| `Ctrl+Enter` | 忙碌时立即发送当前输入并取消当前轮次；空闲时换行 |
| `Ctrl+J` | 换行 |
| `Backspace` | 删除前字符 |
| `Delete` | 删除后字符 |
| `Tab` | 触发自补全 |

### 8.3 快捷键路由优先级

```
1. 权限确认面板 (最高)
2. Todo 编辑器
3. 自动补全覆盖层
4. 全局快捷键
5. 输入框
```

---

## 9. 自动补全

### 9.1 补全模式

```typescript
export type AcMode =
  | "command"      // 斜杠命令补全
  | "file"         // 文件路径补全
  | "model"        // 模型名称补全
  | "model-picker" // 模型选择器
  | "session-list" // 会话列表
  | "resume-messages" // 恢复消息
  | "model-setup"  // 模型配置
  | "profile-name" // 配置名称
  | "profile-list" // 配置列表
  | "multi-agent-model" // 多智能体模型
  | "multi-agent-mode"  // 多智能体模式
  | "multi-agent-roles" // 多智能体角色
  | "multi-agent-role-new" // 新建角色
  | "multi-agent-task"   // 多智能体任务
  | "role-setup"  // 角色配置
  | null;
```

### 9.2 补全触发条件

**命令补全** (`/` 开头):
```typescript
if (ch === "/" && !acMode) {
  setAcMode("command");
  setAcIndex(0);
  loadCommands(input.slice(1));
}
```

**文件补全** (`@` 或路径):
```typescript
const fileTrigger = extractFileAcTrigger(input);
if (fileTrigger && !acMode) {
  setAcMode("file");
  loadFiles(fileTrigger.fragment);
}
```

**模型补全** (`/model`):
```typescript
if (input.startsWith("/model ")) {
  setAcMode("model-picker");
  loadModels();
}
```

### 9.3 补全状态管理

```typescript
export type TerminalAutocompleteState = {
  mode: AcMode;
  index: number;
  commands: CommandDef[];
  files: string[];
  models: string[];
  sessions: PersistedSessionMeta[];
  resumeMessages?: ResumeMessageCandidate[];
  modelContextWindows: Record<string, number>;
  modelQuery: string;
  fileFragment: string;
  // ... 更多
};
```

---

## 10. 开发指南

### 10.1 添加新组件

1. 在 `src/tui/components/` 下创建组件文件
2. 导出 props 类型和组件函数
3. 在 `App.tsx` 中导入并使用
4. 如有需要，更新 `state.ts` 添加相关状态

**示例**:

```typescript
// src/tui/components/MyNewComponent.tsx
import React from "react";
import { Box, Text } from "ink";
import { TUI_COLORS as C } from "../theme.ts";

export type MyNewComponentProps = {
  data: string;
  width: number;
};

export function MyNewComponent({ data, width }: MyNewComponentProps): React.ReactElement {
  return (
    <Box width={width} flexDirection="row">
      <Text color={C.accent}>{data}</Text>
    </Box>
  );
}
```

### 10.2 添加新快捷键

在 `useKeyboardHandler.ts` 中添加：

```typescript
export function useKeyboardHandler(deps: UseKeyboardHandlerDeps): void {
  const { dispatch, ... } = deps;
  
  useInput((_ch: string, key: Key) => {
    // 添加新快捷键
    if (key.ctrl && _ch === "x") {
      dispatch({ type: "MY_NEW_ACTION" });
      return;
    }
    
    // 现有逻辑...
  });
}
```

### 10.3 修改输入框行为

**修改光标样式**:
```typescript
// PromptInput.tsx
function renderInverse(text: string): React.ReactElement {
  return <Text inverse>{text || " "}</Text>;
}
```

**添加新的键盘处理**:
```typescript
useInput((input, key) => {
  // 添加新快捷键处理
  if (key.ctrl && key.shift && input === "a") {
    // 自定义逻辑
    return;
  }
  // 现有逻辑...
}, { isActive: focus });
```

### 10.4 性能优化

**1. 使用 useMemo 缓存计算结果**:
```typescript
const viewportContentHeight = useMemo(
  () => estimateViewportContentHeight({...}),
  [dependencies],
);
```

**2. 避免不必要的重渲染**:
```typescript
// 使用 useRef 存储不触发重渲染的值
const stateRef = useRef(state);
stateRef.current = state;
```

**3. 批量状态更新**:
```typescript
// 合并多个状态更新
dispatch({ type: "BATCH_UPDATE", updates: {...} });
```

### 10.5 测试指南

**单元测试**:
```typescript
import { describe, it, expect } from "vitest";
import { tuiReducer } from "./state.ts";

describe("tuiReducer", () => {
  it("should handle SET_INPUT action", () => {
    const initialState = createInitialState("default-model");
    const newState = tuiReducer(initialState, { type: "SET_INPUT", value: "hello" });
    expect(newState.input).toBe("hello");
  });
});
```

**集成测试**:
```typescript
import { render, screen } from "@testing-library/react";
import { PromptInput } from "./PromptInput.tsx";

describe("PromptInput", () => {
  it("should render placeholder when empty", () => {
    render(<PromptInput value="" placeholder="Type here..." onSubmit={() => {}} onChange={() => {}} />);
    expect(screen.getByText("Type here...")).toBeInTheDocument();
  });
});
```

---

## 附录 A: 主题颜色

```typescript
export const TUI_COLORS = {
  user: "cyan",
  assistant: "white",
  muted: "gray",
  accent: "blue",
  success: "green",
  warning: "yellow",
  error: "red",
  running: "cyan",
  background: "blue",
  bashBorder: "cyan",
  promptBorder: "white",
};
```

## 附录 B: 渲染行类型

```typescript
export type RenderLine = {
  key: string;
  text: string;
  prefix?: string;
  style?: "user" | "assistant" | "muted";
  background?: "user" | "muted";
  dim?: boolean;
  fillWidth?: number;
  ephemeral?: boolean;
};
```

## 附录 C: 事件类型

```typescript
export type LoopEvent =
  | { type: "START_TURN" }
  | { type: "LLM_STREAM_TEXT"; text: string }
  | { type: "LLM_STREAM_REASONING"; text: string }
  | { type: "TOOL_CALL"; toolCall: ToolCall }
  | { type: "TOOL_RESULT"; toolResult: ToolResult }
  | { type: "SUBAGENT_EVENT"; event: SubagentEvent }
  | { type: "TURN_COMPLETE" }
  | { type: "ERROR"; error: Error };
```

---

**文档版本**: v1.0  
**最后更新**: 2025-09-24  
**维护者**: mini-agent-loop team
