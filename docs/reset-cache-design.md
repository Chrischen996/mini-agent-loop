我来仔细分析这套缓存机制设计方案

让我先看看项目现有的结构和代码，再给出有依据的评估。

现在让我查看现有的 TUI 组件和 loop.ts，了解事件消费方式

现在让我看 LoopEvent 类型和 TUI 的 StatusBar 组件

现在让我看看现有的 `/cache` 相关的实现以及 CLI

让我看看关键的 pi-ai/prompt-cache 和 Anthropic 缓存

现在我对项目结构有了充分了解。让我继续分析并给出评估

现在我对项目有了充分了解，来系统性地评估这套方案。

---

## 整体评价

这套方案**方向是对的**——把缓存从黑盒变成可观测的，但设计里有一些和现有代码冲突的地方，需要调整。

## 具体问题

### 1. 架构层：三层设计过度设计

当前 `mini-agent` 是单进程 CLI + TUI，没有独立的 Server 层。方案里的 "Layer 3: TUI/Server" 暗示了一个 Server，但实际只需 TUI。`/cache` 命令可以通过现有的 `ADD_NOTICE` action 实现，不需要新建 Server。

### 2. `CacheMetrics.requestId` 用 UUID 是错的

方案里 `requestId` 用 `crypto.randomUUID()` 生成，但` requestId` 应该是**跨请求关联的 fingerprint**（即前缀哈希），而不是每次请求生成新 UUID。否则你没法把多次请求的 cache 指标关联到同一个 prefix 来看 hit rate。

### 3. `parseCacheMetrics` 的字段和现有 `StreamChatUsage` 不兼容

现有 `StreamChatUsage`（`retry.ts:8`）只有 `promptTokens / completionTokens / totalTokens` 三个字段。方案想加 `cacheRead / cacheWrite / input`，但这两个类型要统一。目前 `StreamChatUsage` 已经被 `loop.ts` 和 `TuiState` 直接消费，硬加字段会破坏兼容性。应该**扩展现有的 `StreamChatUsage`**，而不是另建 `CacheMetrics`。

### 4. `cacheWriteTokens` 计算逻辑有误

方案里 `cacheWriteTokens` 来自 `usage.cacheWrite`，但 cache write 是在**首次请求**或**prefix 变化后**发生的。`analyzeInvalidation` 在 `parseCacheMetrics` 之后才调用，但 `cacheWrite` 应该是从 provider 返回的 usage 里直接取（Anthropic 返回 `cache_creation_input_tokens`，OpenAI 的 `cached_tokens` 是 read）。方案把 write 等于 input_tokens - cacheRead 在数学上不成立。

### 5. StatusBar 用 emoji 有问题

`💾` 和 `📝` 在部分终端（特别是 Windows cmd / 老旧 SSH）渲染为空白或方框。当前 StatusBar 用的是 ANSI 颜色和文字，没有 emoji。建议改用纯文本标记，如 `CACHE:HIT` / `CACHE:MISS`。

### 6. 定价估算不应在缓存追踪器里

方案里 `pricingMap` 写死在 `cache-tracker.ts`，但实际定价应该来自 `models.ts` 或 provider config。不同模型每 token 价格差异很大（DeepSeek V4 约 $0.14/M，GPT-4o 约 $2.5/M），硬编码一个 map 会误导用户。而且 cacheRead 的折扣比例（0.25x / 0.1x）各 provider 不同，这里不需要估计"节省金额"，只需要展示**cache hit rate** 和 **cache 节省的 token 数量**就够了。

### 7. `analyzeInvalidation` 逻辑太简单

只比较 fingerprint 是否变化，无法区分是"系统 prompt 改了"还是"tool schema 变了"。可以改进为：分别 hash system prompt 和 tools，返回更具体的 invalidation reason。

### 8. `/cache` 命令设计缺少具体实现

方案给了命令名和输出格式，但没有说明命令如何接入现有的 CLI/TUI 命令系统。当前 loop.ts 的事件消费里没有任何命令解析逻辑。需要明确 `/cache` 走哪条路径（ADD_NOTICE? 还是专用 TUI panel?）。

## 可行的改进方案

| 方面 | 方案里的设计 | 建议 |
|------|-------------|------|
| 类型体系 | 新建 `CacheMetrics` 独立类型 | 扩展 `StreamChatUsage` 加 `cacheReadTokens / cacheWriteTokens` |
| Fingerprint | SHA256 truncated | 同上，但作为 `requestId` 复用，不是 UUID |
| 事件类型 | `cache_update` 新事件 | 可以，但优先合并进 `assistant` 事件的 usage 里 |
| TUI 显示 | StatusBar 加 emoji | StatusBar 加纯文本 `CACHE:82%` |
| 定价估算 | 硬编码 pricingMap | 去掉货币估算，只展示 token 节省 |
| Invalidation | fingerprint 相等性 | 分别 hash system prompt + tools，给出具体原因 |
| `/cache` 命令 | 独立命令 handler | 通过 `ADD_NOTICE` 实现最省事 |

## P0 优先级修正

方案把 "Usage parsing enhancement + CacheMetrics type" 列为 P0，但其实和现有 `StreamChatUsage` 有冲突。更合理的 P0 应该是：

1. **扩展 `StreamChatUsage`**（在 `retry.ts` 加 `cacheReadTokens? / cacheWriteTokens?`）
2. **在 `chat.ts` 的 SSE 解析里提取 cache 字段**（Anthropic 的 `cache_read_input_tokens` / `cache_creation_input_tokens`，OpenAI 的 `cached_tokens`）
3. **把 cache 指标传给 TUI state**（在 `LoopEvent` 的 `assistant` event 里带上）

这样第一步就能看到实际效果，不需要先建一个完整的 `CacheTracker` 模块。

TDDO

## 优先级和实施路线图建议

基于现有代码结构，我建议调整为：

| Phase | 实际可行的内容 | 复杂度 | 价值 |
|-------|---------------|--------|------|
| **P0** | 扩 `StreamChatUsage` + 在 `chat.ts` 提取 cache 字段 + 传给 `LoopEvent` | 低 | 拿到真实数据 |
| **P1** | 在 TUI StatusBar 显示 cache hit rate（纯文本） | 低 | 用户能感知 |
| **P2** | 前缀 fingerprint + invalidation 分析（利用现有的 `computePrefixFingerprint` 思路） | 中 | 可观测性 |
| **P3** | `/cache status` 命令（通过 `ADD_NOTICE` 实现） | 低 | 交互能力 |
| **P4** | 优化建议（system prompt 长度检查、工具定义稳定性建议） | 高 | 性能提升 |

## 结论

方案**整体框架可行**，但细节上和现有代码有多处冲突：
- 类型体系需要兼容而非另起炉灶
- 不该硬编码定价和货币估算
- 不该用 emoji（兼容性差）
- `CacheTracker` 作为独立模块是合理的，但实现细节需要基于现有 `StreamChatUsage` 扩展

要我基于这些反馈改一个修正版的实现吗？

评估已完成。