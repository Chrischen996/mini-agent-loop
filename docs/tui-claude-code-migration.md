# Claude Code 风格 TUI 输入框迁移方案

> 本文档是 `mini-agent-loop` 的输入框迁移设计与实施计划，不代表功能已经落地。本文档更新不会修改任何运行时代码。

## 1. 目标与范围

目标是在保持现有 Ink TUI 输入体验和快捷键兼容性的前提下，吸收 Claude Code 输入框的几个高价值设计：清晰的输入区域边界、语义化状态色、词级编辑、稳定的多行视口，以及更可靠的终端协议兼容性。

本次范围：

- 输入区域的视觉容器和语义化边框色。
- `Ctrl+Left` / `Ctrl+Right` 词级导航。
- 当前行级别的 `Home` / `End` 行为。
- 多行输入视口和光标可见性验证。
- 输入快捷键路由、终端协议降级和测试补齐。

明确不在本次范围：

- Claude Code 的 Companion Sprite、语音波形、会话恢复 UI。
- 全屏备用缓冲区重构。
- 替换现有 `useReducer`、消息视口或自动补全体系。
- 将所有 Claude Code 交互逐项复制。

## 2. 当前实现审计

审计基线：当前工作区的 `feature/claude-code-terminal` 分支，`src/tui/components/PromptInput.tsx` 为 317 行。

### 2.1 组件与数据流

```text
App.tsx
  ├─ useKeyboardHandler.ts             全局快捷键、权限、滚动、覆盖层路由
  ├─ components/MessageFeed.tsx        对话和流式内容视口
  ├─ components/Overlays.tsx           补全、选择器和编辑器覆盖层
  └─ 输入行 Box
       ├─ Text("❯")                   提示符，由 App 渲染
       └─ components/PromptInput.tsx   输入内容、光标和局部编辑
```

`PromptInput` 不是独立的全宽卡片。`App.tsx` 将 `❯` 和 `PromptInput` 放在同一个横向 `Box` 中，二者是兄弟元素；`PromptInput` 通过 `flexGrow={1}`、`minWidth={0}` 占据提示符之后的剩余空间。

### 2.2 已有能力

以下能力已在当前实现中存在，应复用而不是重新造一套输入内核：

| 能力 | 当前实现 |
|---|---|
| 图符安全编辑 | `splitGraphemes()` 使用 `Intl.Segmenter`，无此 API 时回退到 code point 遍历。 |
| 多行输入 | `Ctrl+Enter`、`Meta+Enter`、`Ctrl+J` 插入换行。 |
| 字符编辑 | 左右移动、Backspace/Delete 前删，均按 grapheme 处理。 |
| 上下移动与历史 | 多行草稿优先逐行移动；到边界后才查历史；空单行草稿可转交上下文滚动。 |
| 输入视口 | `MAX_VISIBLE_LINES = 10`；显示窗口始终覆盖光标所在行。 |
| 输入呈现 | placeholder、反色光标、掩码输入、图片附件、Tab 补全。 |
| 全局滚动 | PageUp/PageDown、鼠标 SGR 滚轮、Ctrl+G 均已经服务于消息视口。 |

### 2.3 尚未实现的能力

| 能力 | 现状 | 本计划的处理 |
|---|---|---|
| 边框和模式色 | 尚无 `borderMode`、`modeColor` 或输入容器边框。 | 在输入行父容器增加可开关的语义化视觉层。 |
| 词级移动 | 没有 `Ctrl+Left/Right`。 | 在 `PromptInput` 的现有 grapheme helpers 上实现。 |
| 行首/行尾 | 当前未实现当前行级别 Home/End。 | 加入 `moveToLineStart` / `moveToLineEnd` 纯函数。 |
| Esc 双击清空 | 不存在。 | 默认不迁移，避免覆盖 busy 状态下的取消生成。 |
| 原生终端光标声明 | 不存在。 | 作为 IME 兼容性调研项，不能在未验证 Ink API 前承诺实现。 |
| 全屏模式 | 没有独立的 alternate-screen 输入布局。 | 不在本期范围。 |

### 2.4 需要纠正的假设

- 不应把当前输入描述为“固定宽度”。它已经通过 Flex 适应终端宽度。
- 不应使用 `columns - 3` 作为 `PromptInput` 的宽度。该公式忽略了现有兄弟提示符、父容器 padding 和 Ink 的 Flex 布局，窄终端下可能溢出。
- 不应新建一套持久化 `Cursor` 类和全局 cursor reducer。现有光标状态属于 `PromptInput`，纯 grapheme helper 已足够支撑本次能力。
- 不应把 PageUp/PageDown 改为输入跳转。它们已有稳定的消息滚动语义。
- 不应把 Esc 双击清空设为默认行为。`useKeyboardHandler` 中，busy 且无补全时的 Esc 用于取消 LLM 生成。

## 3. 目标交互设计

### 3.1 视觉布局

输入区域继续作为底部 chrome 的一部分，避免让独立卡片挤占消息视口：

```text
┌──────────────────────────────────────────────────────────────┐
│ MessageFeed                                                   │
├──────────────────────────────────────────────────────────────┤
│ [可选输入容器：❯  多行输入文本和反色光标              状态] │
└──────────────────────────────────────────────────────────────┘
```

实现时应由一个父 `Box` 同时包裹提示符和 `PromptInput`，而不是给 `PromptInput` 设置全终端的显式宽度。父容器保持 `width={termWidth}`，内部让内容区 `flexGrow={1}`、`minWidth={0}`。所有边框/padding 由同一容器承担，以保证窄终端时不会与 `❯` 重叠。

推荐第一版使用完整矩形边框：

```tsx
<Box
  borderStyle="round"
  borderColor={inputBorderColor}
  borderTop={true}
  borderRight={true}
  borderBottom={true}
  borderLeft={true}
  paddingX={1}
  width={termWidth}
>
  <Text color={C.user} bold>❯</Text>
  <PromptInput {...props} />
</Box>
```

`borderStyle="round"` 与仅底边同时使用时通常无法呈现真正的圆角，因此不将“仅底边圆角”作为首版目标。若后续为密度改成单边分隔线，应采用直线风格并单独截图验收。

### 3.2 颜色策略

当前 `TUI_COLORS` 已包含：`primary`、`info`、`planMode`、`user`、`assistant`、`muted`、`border`、`selection`、`thinking`、`running`、`success`、`error`、`badgeText`、`userBg`、`gutter`。

当前不存在 `bashBorder`、`promptBorder` 或 `agentBorder`。首版不复制 Claude Code 的 bash/agent/prompt 命名，而应优先复用：

| 输入状态 | 推荐色 | 说明 |
|---|---|---|
| 普通可编辑 | `C.border` | 低干扰默认边框。 |
| plan 模式 | `C.planMode` | 与已有计划模式保持一致。 |
| 忙碌但仍可排队 | `C.running` | 仅在状态语义明确时使用。 |
| 权限确认/错误 | `C.error` | 不把它用作常规输入状态。 |

如果现有语义色无法表达需求，再新增 `inputBorder`、`inputBorderActive` 这类明确的主题 token；禁止添加与现有业务无关的 bash/agent 色名。

### 3.3 编辑与快捷键规范

| 按键 | 当前行为 | 迁移后行为 |
|---|---|---|
| Left/Right | 按 grapheme 移动 | 保持不变。 |
| Ctrl+Left/Right | 未实现，Ctrl/Meta 通常交给应用 | 在确认未被全局路由占用后，按词移动；无法识别协议时退化为无动作。 |
| Up/Down | 多行内移动、历史或上下文滚动 | 保持不变。 |
| Home/End | 当前没有输入框专用行级处理 | 跳至当前逻辑行首/行尾。 |
| Ctrl+Enter、Meta+Enter、Ctrl+J | 插入换行 | 保持不变。 |
| PageUp/PageDown | 滚动消息视口 | 保持不变。 |
| Esc | busy 时取消生成；Todo/覆盖层有更高优先级 | 保持不变，不引入默认双击清空。 |
| Tab/Shift+Tab | Tab 补全；Shift+Tab 切换权限模式 | 保持不变。 |

### 3.4 快捷键路由约束

新增快捷键必须服从已有所有权，不能只在 `PromptInput` 中局部处理：

1. 待确认权限优先处理其决定键。
2. Todo 编辑器优先处理编辑器导航和确认键。
3. 计划审批状态优先处理审批/拒绝键。
4. 全局处理器接管 Ctrl+C、busy Esc、Shift+Tab、Ctrl+T、Alt+T、Alt+上下、PageUp/PageDown、Ctrl+G 和复制相关快捷键。
5. 自动补全覆盖层接管其导航和确认键。
6. `PromptInput` 最后处理普通输入、局部编辑、单行历史和多行草稿移动。

`PromptInput` 目前主动放行多数 Ctrl/Meta chord 给应用。实现 Ctrl+Left/Right 时必须在这条放行逻辑之前精确匹配，且不能吞掉未识别的修饰键组合。

## 4. 分阶段实施计划

### 阶段 0：基线与开关

**依赖**：无。

**工作**：

- 增加 `TUI_CLAUDE_STYLE_INPUT=1` 功能开关，默认关闭。
- 确定边框只改变 Ink 界面，还是同时改变 headless 渲染模型。
- 为目标终端准备手工测试清单：Terminal.app、iTerm2、VS Code Terminal、常见 xterm 兼容终端，以及支持 kitty keyboard protocol 的终端。

**验收**：未启用开关时，渲染、按键和现有快照均不发生变化。

### 阶段 1：抽取并测试纯编辑 helper

**依赖**：阶段 0。

**工作**：

- 保留 `splitGraphemes()`，从 `PromptInput.tsx` 提取或补充纯函数：`moveWordLeft`、`moveWordRight`、`moveToLineStart`、`moveToLineEnd`。
- 使用 `string[]` + grapheme cursor 索引作为输入输出；不引入可变 `Cursor` 类。
- 词边界规则先采用“空白和非空白”策略，并明确这不是语言学分词；后续再按用户反馈支持标点边界。

**验收**：中文、emoji、组合字符、空白串、标点、行首/行尾和多行草稿均不出现越界或 Unicode 拆分。

### 阶段 2：接入局部编辑快捷键

**依赖**：阶段 1、终端协议验证。

**工作**：

- 在 `PromptInput` 的 Ctrl/Meta 放行前识别 Ctrl+Left/Right。
- 加入 Home/End 的当前行处理；若 Ink 未可靠提供对应 `Key` 字段，再在 headless controller 的协议解析层补充。
- 不改变 PageUp/PageDown、Esc 或 Shift+Tab 的既有所有权。

**验收**：新增键在无补全、无 Todo、无权限弹层时有效；存在覆盖层时不会穿透并修改草稿。

### 阶段 3：输入容器视觉层

**依赖**：阶段 0。

**工作**：

- 在 `App.tsx` 的输入行父容器上实现开关控制的边框和 padding。
- 复用 `TUI_COLORS` 语义色；根据权限模式或明确的运行状态选择边框色。
- 保持 `PromptInput` 的 `flexGrow` / `minWidth`，不传 `columns - 3` 宽度。
- 测试最小宽度、长 placeholder、长模式文本、图片附件和多行输入。

**验收**：80、40、20 列终端中不截断提示符、不与状态栏重叠、不导致 Ink 清屏闪烁。

### 阶段 4：渲染模型一致性

**依赖**：阶段 3。

**工作**：

- 决定 `terminal-render-model.ts` 的 `buildTerminalRenderLines()` 是否输出与 Ink 一致的边框行。
- 若为 Ink-only 视觉增强：在文档和测试中明确 headless 输出不保证边框一致，并不修改 RenderLine 快照。
- 若 headless 也应体现边框：新增稳定的 `RenderLine` 表达，调整相应快照和宽度测试，避免使用 ANSI 拼接绕过格式化层。

**验收**：选择有文档记录；测试明确覆盖该选择，避免 live Ink UI 与 headless/snapshot 结果无意漂移。

### 阶段 5：发布验证与回退

**依赖**：前四阶段。

**工作**：

- 默认仍关闭功能开关，先在内部环境验证。
- 收集终端类型、键序列、IME 行为和输入丢字/错位问题。
- 逐步默认开启；异常时通过环境变量立即回退。

**验收**：没有 P0 输入丢失、无法提交、快捷键穿透或窄终端崩坏问题；关闭开关后可恢复原体验。

## 5. 终端协议与 IME 兼容性

### 5.1 Ctrl+Left/Right

不同终端可能将修饰箭头编码为不同 CSI 序列；kitty keyboard protocol 还可能使用 Unicode key protocol。实现前需要：

- 在 `terminal-input-controller.ts` 的协议解析中，为 xterm 风格和 kitty 风格序列添加明确映射。
- 在 Ink 的 `Key` 对象可同时表达 `ctrl` 与 arrow 时优先走 Ink 路径；原始 stdin controller 仅作为无头/协议覆盖路径。
- 对未识别序列保守处理：不插入转义文本、不移动到错误位置、不吞掉普通字符。
- 记录实际终端和收到的序列，新增协议时以测试用例固定行为。

### 5.2 CJK 与 IME

当前 grapheme 分割可避免删除和移动时拆开 emoji、组合字符或多数 CJK 字符，但它不等于完整 IME 集成。原生终端光标位置会影响部分 IME 的 preedit 文本呈现。

首版保持现有反色光标，不宣称完整 IME 原生 cursor 支持。若要引入原生 cursor 声明，必须先验证 Ink 版本支持的 API、alternate screen 行为、窄终端换行和 macOS/Linux 终端差异，并在缺少 API 时保留反色光标作为降级方案。

## 6. 测试策略

本仓库使用 `node:test`；不要在本计划中引入 React Testing Library、DOM query selector 或 `vi.fn` 作为默认测试方案。

### 6.1 自动化测试

| 测试层 | 位置 | 核心覆盖 |
|---|---|---|
| 纯函数测试 | `test/tui-input.test.ts` 或新增相邻测试文件 | grapheme、词边界、行首/尾、空值和 Unicode 边界。 |
| 控制器测试 | `test/tui-input.test.ts` / controller 对应测试 | xterm/kitty 序列、Ctrl+箭头、未完整 CSI 序列缓存和降级。 |
| 路由测试 | `test/tui-input.test.ts`、`test/tui-consistency.test.ts` | 补全、Todo、权限、busy Esc、PageUp/Down 不被输入框抢占。 |
| 渲染模型测试 | `test/tui-consistency.test.ts` | 仅当阶段 4 选择同步边框时更新 RenderLine 断言。 |
| Ink 渲染测试 | 复用现有 Ink 测试 harness（若可用） | 边框宽度、窄终端、多行/附件不溢出。 |

### 6.2 手工终端矩阵

每次涉及按键协议或边框布局的变更，都至少验证：

- Terminal.app、iTerm2、VS Code Terminal。
- xterm 兼容终端，以及启用 kitty keyboard protocol 的终端。
- 20、40、80、120 列，短终端高度和正常高度。
- 英文、中文、emoji、组合字符、长路径和多行粘贴。
- 普通、busy、补全、Todo、权限确认、plan review 状态。

## 7. 风险与回退

| 风险 | 影响 | 缓解措施 |
|---|---|---|
| 修饰箭头协议不一致 | Ctrl+Left/Right 无效或误输入字符 | 双协议测试、未知序列无动作、开关回退。 |
| 快捷键所有权冲突 | 覆盖层打开时误改草稿或无法确认 | 按既有路由顺序写测试；禁止在 PromptInput 中抢全局键。 |
| 边框改变高度 | 消息区域减少、窄终端触发闪烁 | 使用已有布局计算；20/40 列和低高度验证。 |
| Ink/headless 分歧 | 快照与真实 TUI 不一致 | 阶段 4 先作明确决策并测试。 |
| IME preedit 表现差异 | 特定终端输入法候选位置异常 | 不把原生 cursor 声明作为首版阻塞项；保留反色光标降级。 |

回退方式：

```ts
const useClaudeStyleInput = process.env.TUI_CLAUDE_STYLE_INPUT === "1";
```

该开关应覆盖视觉容器和新键行为的启用路径；默认值为关闭。出现输入阻塞、协议误解析或布局异常时，可不发布新代码而通过环境变量关闭功能。

## 8. 文件影响清单

| 文件 | 预期变更 | 阶段 |
|---|---|---|
| `src/tui/components/PromptInput.tsx` | 新增纯编辑 helper 的调用、词级导航、当前行 Home/End；保持现有光标状态。 | 1-2 |
| `src/tui/App.tsx` | 在输入提示符与 PromptInput 的共同父容器上接入开关控制的边框。 | 3 |
| `src/tui/theme.ts` | 仅在现有语义色不足时新增明确的 input 主题 token。 | 3 |
| `src/tui/hooks/useKeyboardHandler.ts` | 仅在路由需要时传递/保护输入所有权；保留 Esc、分页、权限等全局语义。 | 2 |
| `src/tui/terminal-input-controller.ts` | 仅为确认需要的 xterm/kitty 修饰箭头协议添加解析和测试。 | 2、5 |
| `src/tui/terminal-render-model.ts` | 仅当决定 headless 与 Ink 同步呈现边框时修改。 | 4 |
| `test/tui-input.test.ts` | 新增纯 helper、输入路由和协议解析测试。 | 1-2 |
| `test/tui-consistency.test.ts` | 仅在改变 headless RenderLine 规范时更新。 | 4 |
| `docs/tui-claude-code-migration.md` | 本设计和审计记录。 | 本次 |

## 9. 实施完成定义

迁移完成需要同时满足：

- 功能开关关闭时，现有输入行为和现有测试全部保持不变。
- 开启时，边框在 20 列以上终端不溢出，提示符和输入不重叠。
- Ctrl+Left/Right、当前行 Home/End 对 Unicode 文本正确工作，并在未识别终端协议下安全降级。
- Esc、PageUp/PageDown、Shift+Tab、权限确认、Todo、补全和 busy 取消生成仍由原有所有者处理。
- 自动化测试和手工终端矩阵均通过。
- 对 headless 渲染是否同步边框有明确、已测试的决策。

## 参考

- [Claude Code 仓库](https://github.com/Chrischen996/claude-code)
- [Ink 文档](https://github.com/vadimdemedes/ink)
- [Unicode 文本处理](https://mathiasbynens.be/notes/javascript-unicode)
- [xterm 控制序列](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html)

---

**文档版本**：v1.1  
**最后更新**：2026-09-24  
**更新说明**：根据当前 TUI 代码审计补充并修正迁移边界、快捷键路由、布局、测试、headless 渲染与终端协议兼容性。  
**代码状态**：本次仅更新文档，未修改运行时代码，也未创建提交。
