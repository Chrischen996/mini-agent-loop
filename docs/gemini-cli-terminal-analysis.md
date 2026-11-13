# Gemini CLI 终端 UI 设计分析与 mini-agent-loop 借鉴评估

> 调研对象：`google-gemini/gemini-cli`（@ aeb6c04，`packages/cli`）
> 对比基线：`mini-agent-loop` 当前 TUI（`src/tui/incremental-renderer.ts` + `src/tui/message-viewport.ts`）

## 1. Gemini CLI 终端设计

### 1.1 渲染层：Ink fork + React 19

- 使用 fork `@jrichman/ink`（`packages/cli/package.json:52`，npm alias 引入），提供上游没有的：`alternateBuffer` / `terminalBuffer` / `incrementalRendering` / `StaticRender` / `ResizeObserver`。
- 入口 `src/interactiveCli.tsx` `startInteractiveUI`（L53–220）：
  - L60 全局替换字符串宽度计算为缓存版 `getCachedStringWidth`；
  - Provider 嵌套树：`Settings → KeyMatchers → Keypress → Mouse → Terminal → Scroll → Overflow → SessionStats → VimMode → AppContainer`；
  - L160–166：单帧 > 200ms 触发 `recordSlowRender` + profiler 上报（慢帧监控）。
- `ui/App.tsx` 仅 39 行（屏幕阅读器/默认布局二分）；`AppContainer.tsx` ≈600 行集中全部 hooks（容器/展示分离）。

### 1.2 布局与三种 scrollback 策略

垂直布局（`ui/layouts/DefaultAppLayout.tsx` L44–97）：

```
MainContent(消息区)
→ 可选 BackgroundTaskDisplay(内嵌 shell)
→ Composer(状态行 → 排队消息 → TodoTray → 快捷键帮助 → Toast → InputPrompt → Footer)
```

inline 模式下动态区高度封顶 `terminalHeight - 1` + `flex-end`，输入框恒可见。

核心设计——**"定型 vs 进行中"历史模型**（`ui/components/MainContent.tsx`）：

| 模式 | 策略 | 位置 |
|---|---|---|
| inline（默认） | 完成消息经 `<Static>` 一次性写入终端**原生 scrollback**，永不重渲染；动态区只画 pending 流式项 + 输入区 | L459–471 |
| alternate buffer | 主区换成自定义 `ScrollableList`（虚拟列表），全屏 alt screen，自带虚拟滚动/滚动条 | L400–429 |
| terminal buffer | 同虚拟列表，但定型项交给 fork 的 `StaticRender` 写入终端 backbuffer，保留原生滚动 | L411–414 |

`STATIC_HISTORY_ITEM_TYPES`（L57–75）：user/gemini/info/error 等 20 种定型类型；`tool_group` 等动态类型永不 static。pending 项高度用 Largest Remainder Method 预算（L235–275）。

### 1.3 输入交互（`ui/components/InputPrompt.tsx` ≈1300 行）

- 多行编辑器 `components/shared/text-buffer.js`：逻辑行/视觉行分离、按码点切片、光标 `[row, col]`，纯终端复刻编辑器体验；Shift+Enter 换行；
- 大粘贴折叠为 paste placeholder（Ctrl+O 展开）；kitty 协议下可信，否则 40ms 窗口屏蔽自动提交；
- 快捷键：`Command` 枚举 + `keyMatchers` 匹配器，用户可重绑；
- 补全：`useCommandCompletion`（slash/参数/文件/shell，`fzf` 模糊匹配）+ ghost text Tab 接受 + Ctrl+R 反查；
- 其他：`!` shell 模式、双击 Esc 触发 `/rewind`、鼠标点击定位光标、Ctrl+V 图片转 `@path`、vim 模式、语音输入、生成中排队消息。

### 1.4 流式输出（`ui/hooks/useGeminiStream.ts` ≈2500 行状态机）

- 首块到达创建 `pendingHistoryItem`，chunk 持续追加；thinking 独立 state 分渲染；
- 消息完成瞬间"毕业"进 history，inline 模式被 `<Static>` 接管、永远不再重画；
- `MAX_GEMINI_MESSAGE_LINES` 封顶单条消息行数，防极端响应打爆渲染。

### 1.5 交互 vs headless：完全分叉

`src/gemini.tsx` L936 `if (config.isInteractive())`：交互路径动态 `import('./interactiveCli.js')`；`-p` headless 路径**零 Ink/React**，走独立 `runNonInteractive`（纯流式 stdout/stderr），仅在 config 层共享。

## 2. mini-agent-loop 现状基线

| 能力 | 现状 |
|---|---|
| 行级 diff 渲染 | ✅ `IncrementalTerminalRenderer`：只画变化行、物理视口内绝对定位、流式不清屏（`ESC[2J` 不变式） |
| 定型块布局缓存 | ✅ `message-viewport.ts` 两层 `PhysicalRow[]` 缓存（WeakMap + 前缀和） |
| 定型消息免每帧 diff | ❌ 完成消息仍参与每帧全视口行 diff，成本 O(视口行数) |
| 深历史可见性 | ⚠️ 超出视口被裁剪为 "N 行隐藏" 提示，无原生 scrollback 深度 |
| 宽度计算 | ❌ 每帧现算 `graphemeWidth`（CJK/emoji 场景最贵） |
| 渲染监控 | ❌ 无慢帧/闪烁检测 |
| 全屏虚拟列表 | ❌ 无 alt buffer 模式 |
| headless 分叉 | ✅ `src/cli.ts` 天然独立入口 |

## 3. 各项加入后的收益评估

### 3.1 `<Static>` 定型/pending 分治（最高 ROI）

| 维度 | 收益 |
|---|---|
| 性能 | 每帧 diff 成本 O(视口行数) → O(pending + 输入区)；几百条消息的长会话，流式 token 到达时只 diff 几十行 |
| 功能 | 终端原生 scrollback 无限深：鼠标可滚回几百轮之前且保真，替代 "N 行隐藏" 提示 |
| 兼容性 | Ink 上游自带 `<Static>`，无需 fork；定型输出发生在消息完成瞬间，与"流式不清屏"不变式不冲突 |

主要工作：stdout adapter 分流——定型帧一次性放行主屏，动态区继续行级 diff。

> ⚠️ **前置依赖（现状补齐）**：原生 scrollback 深历史只在 **inline（非 alt screen）** 模式下成立——alt screen（`\x1b[?1049h`，当前 `ink-main.tsx` 全量启用）本身不保留滚动历史。因此 §3.1 要真正受益，必须先让 `<Static>` 分支脱离 alt screen 走 inline 布局，这会牵动现有"alt screen 内绝对定位不清屏"的整个渲染路径，风险高于"stdout 分流"一句话所述的量级。
> 由此 §4 的优先级应修正为：**先做布局模式开关（inline 为 `<Static>` 默认路径），alt screen 降级为不依赖终端 scrollback 的备选模式**——两者从"1 优先 / 4 后置"的关系变成"可选布局决定走哪套"，且最终目标架构需要 __inline+Static__ 与 __alt+VirtualList__ 双路径并存。

### 3.2 字符串宽度缓存（小投入）

- 每帧宽度计算 O(字符数) → 查表；中文/emoji 会话 CPU 可测下降；
- 布局/diff/截断三处统一口径，降低"行宽算错导致整行错位"的 bug 面；
- 工作量：小（Map 缓存 + 挂载到 truncate/layout 调用点）。

### 3.3 慢渲染监控 + 闪烁检测（可观测性）

- 帧计时钩子：> 200ms 记录并上报；闪烁检测：同位置反复重画告警；
- 收益不是性能本身，而是**让回归可见**——能量化"改动前后 p95 帧耗时"，等于给渲染层装回归哨兵；
- 工作量：很小。

### 3.4 alt buffer 虚拟列表模式（重投入，建议后置）

- 收益：不依赖终端 scrollback 能力（iTerm/konsole/tmux/SSH 全一致），UI 内滚完整段对话，小终端下状态栏/输入区不被顶掉；
- 代价：需要 fork 的 altBuffer + 自定义 VirtualizedList + 鼠标滚轮协议，工作量为前述总和的数倍；
- 建议：做成配置开关，最后实施；`StaticRender`/backbuffer/同步输出跟随此项。

### 3.5 不建议照抄

- headless 完全分叉（已有等价设计）；
- 键位重绑系统（交互功能，与渲染收益无关，按需求另议）。

## 4. 优先级路线图

| 顺序 | 项 | 收益 | 工作量 |
|---|---|---|---|
| 1 | 布局模式开关（inline 默认 / alt buffer 备选） | 前置项：决定后续走 `<Static>` 还是 VirtualList | 中 |
| 2 | `<Static>` 定型分治（inline 路径） | 性能 O(视口)→O(pending) + 原生 scrollback 深度 | 中 |
| 3 | 宽度缓存 | CJK/emoji CPU 下降、行数学一致性 | 小 |
| 4 | 慢帧/闪烁监控 | 渲染可观测、回归哨兵 | 小 |
| 5 | alt buffer 虚拟列表（备选模式） | 不依赖终端 scrollback 时的全场景滚动一致 | 大 |
| 6 | backbuffer / 同步输出 | 跟随第 5 项 | 中 |

**结论**：最值得加的是 `<Static>` 分治——现有实现已解决"重复布局"，未解决"定型历史仍参与每帧 diff"与"历史深于视口即不可见"。但要真正拿到原生 scrollback 深度，必须先解决前置的布局模式选择（inline vs alt screen）；宽度缓存与监控是顺手小钱；alt buffer 虚拟列表大投入可作为不依赖终端能力的备选模式后置。

## 5. main 分支源码复核（2026-11，codeload tarball 实测）

对照当前 main 重新核实三个关键问题的实现（`packages/cli/src/ui/`）：

### 5.1 Header 怎么放（`components/MainContent.tsx`）

默认（inline）路径的最终输出就是：

```tsx
<Static key={historyRemountKey}
        items={[<AppHeader/>, ...historyItems.slice(staticHistoryStartIndex)]}>
{pendingItems}
```

**Header 是 `<Static>` 的第一项**：打印一次进终端流，之后随历史滚进 scrollback，动态帧里永远没有它。terminalBuffer 新路径同理（`isStaticItem(header) === true` → `StaticRender`）。mini-agent document 模式已对齐此做法（`headerStaticText` 一次性 burst）。

### 5.2 流式内容会不会截断（会）

- 静态化是**消息/条目粒度**：`STATIC_HISTORY_ITEM_TYPES`（user/gemini/thinking/info/…）完成才从 pending 移入 history 进 Static；`tool_group` 永不静态（与 mini-agent 的 subagent/工具卡规则一致）。
- pending 项留在动态帧里，按 `availableTerminalHeight` 用 Largest Remainder 分配高度预算——装不下就截。代码块更有显式占位符：pending 且超高时显示 `... code is being written ...`（`utils/MarkdownDisplay.tsx` RenderCodeBlockInternal）。
- 表格：需 header+separator 两行确认才成表（`tableRowRegex`+`tableSeparatorRegex`），流式中整块留在 pending 帧内，完成才进 Static。
- 结论：gemini-cli 默认模式仍有"流式临时截断"。mini-agent document 模式的行级发射（完成一行进流一行、无提示、无预算截断）在连续性上强于 gemini 默认路径。



### 5.3 resize 怎么办（值得抄）

`hooks/useStaticHistoryStartIndex.ts`：宽度变化 → `historyRemountKey` 变更 → `<Static>` 重挂载 → **重新打印最近历史窗口**：从新往旧累计，至少覆盖一屏（`countHistoryItemMinRows ≥ terminalHeight`），字符预算 `RESIZE_REFRESH_MAX_HISTORY_CHARS = 1000` 之外且已过一屏即停。更旧的条目不重打（留在 scrollback，哪怕换行已乱）。即：接受 scrollback 里存在"旧宽度版本"，用重打尾部保证 resize 后可见区域正确。

mini-agent 目前定型行/已发行冻结旧换行、不重打；若 resize 后历史观感成为抱怨点，可按此方案在宽度变化时重打最近一屏。

### 5.4 其它

- ink 依赖是 fork：`"ink": "npm:@jrichman/ink@6.6.9"`，带 `StaticRender` 导出（terminalBuffer 路径的 backbuffer 打印原语）。
- 三条渲染路径开关（`config/settingsSchema.ts`）：`useAlternateBuffer`（默认 false）、`terminalBuffer`（默认 false；`useAlternateBuffer.ts` 注释明言它将成为唯一路径）、否则 inline Static。`isAlternateBufferEnabled = alternate || terminalBuffer`——terminalBuffer 按 alt-buffer 特判处理，但其 VirtualizedList 配 `renderStatic` + `overflowToBackbuffer` 时 static 项打进 backbuffer、pending 项保持动态，架构上正向"整个会话是一条列表、完成项全部进终端流"收敛——与 mini-agent document 模式同一方向。


### 5.5 主题选择（已移植）

mini-agent 现在带 gemini 风格主题系统：`src/tui/theme.ts`（语义槽位 + 可变 `TUI_COLORS` 单例 + env/JSON 持久化选择 + `/theme` 命令）与 `src/tui/gemini-palettes.ts`（19 个 gemini 内建 ColorsTheme 块，由 `tools/extract-gemini-palettes.cjs` 从上游源码抽取）。ColorsTheme→槽位映射：assistant=Foreground、user=AccentBlue、thinking=AccentPurple、running=AccentYellow、success=AccentGreen、error=AccentRed、muted=Gray、gutter/border=DarkGray、userBg=MessageBackground、badgeText 按 type 取 Background/Foreground。`claude-dark`（原品牌色）保持默认。切换时借用 resize-refresh 通道重打最近一屏，可见历史即时换新色。

**启动选择（对齐上游 `ThemeDialog.tsx` + `useThemeCommand.ts`）**：首次启动且无显式选择（env/store 皆无）时自动弹出 `components/ThemeDialog.tsx`——↑↓ highlight 即调 `applyTheme` 全 UI 实时预览（gemini 的 onHighlight 同款，得益于可变调色板单例无需其 remount 机制）、Enter 持久化提交、Esc 恢复原主题且不持久化（下次再问）。`/theme` 无参数也打开该对话框。上游的 scope 选择（User/Workspace）与终端背景色兼容性检测（queryTerminalBackground）未移植——mini-agent 只有用户级 theme.json，且默认不做背景探测。
