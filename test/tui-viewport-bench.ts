// Temporary TUI scaling benchmark: measure how render-pipeline costs scale
// with transcript size N. Run: npx tsx test/tui-viewport-bench.ts
import {
  MessageHeightCache,
  estimateViewportContentHeight,
  estimateViewportActualHeight,
  selectMessageViewport,
} from "../src/tui/message-viewport.ts";
import type { ChatMessage } from "../src/tui/state.ts";

const WIDTH = 120;

function markdownBlock(i: number, lines: number): string {
  const parts: string[] = [`## Section ${i}`, "", "Some **bold** and `inline` text with a [link](https://example.com).", "", "```ts"];
  for (let l = 0; l < lines; l++) parts.push(`const line_${l} = "value_${i}" + ${l};`);
  parts.push("```", "");
  for (let l = 0; l < lines; l++) parts.push(`- bullet ${l} for item ${i}`);
  parts.push("", "> A quoted paragraph that wraps around the terminal width a few times so we can observe wrap-aware row counting in the viewport estimator.");
  return parts.join("\n");
}

function buildMessages(n: number): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (let i = 0; i < n; i++) {
    if (i % 3 === 0) {
      messages.push({ kind: "user", text: `Please implement feature #${i} and write tests for it.` });
    } else if (i % 3 === 1) {
      messages.push({ kind: "assistant", text: markdownBlock(i, 40) });
    } else {
      messages.push({
        kind: "tool_call",
        id: `tool-${i}`,
        name: "bash",
        args: JSON.stringify({ command: `echo step ${i}` }),
        rawArgs: { command: `echo step ${i}` },
        status: "done",
        result: Array.from({ length: 30 }, (_, l) => `line ${l} of output for tool ${i}`).join("\n"),
        startedAt: Date.now(),
        durationMs: 42,
      } as ChatMessage);
    }
  }
  return messages;
}

function bench(label: string, fn: () => void, iterations = 200): number {
  // warmup
  for (let i = 0; i < 10; i++) fn();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) fn();
  const t1 = process.hrtime.bigint();
  const usPerCall = Number(t1 - t0) / 1e3 / iterations;
  console.log(`${label.padEnd(56)} ${usPerCall.toFixed(1).padStart(9)} µs/call`);
  return usPerCall;
}

function prime(cache: MessageHeightCache, opts: { messages: ChatMessage[]; subagentById: Record<string, never>; toolById: Record<string, never> }): void {
  cache.getHistoryEntry(opts.messages, {
    width: WIDTH,
    thinkingMode: "summary",
    expandedThinking: [],
    maxMessages: Number.MAX_SAFE_INTEGER,
    subagentById: opts.subagentById,
    toolById: opts.toolById,
    subagentRevision: 0,
    toolRevision: 0,
  });
}

for (const n of [50, 100, 200, 500, 1000, 2000]) {
  console.log(`\n=== N = ${n} messages ===`);
  const messages = buildMessages(n);

  // 1. Cold build (no cache): full O(N) markdown walk.
  const noCache = {
    messages,
    streamingText: "",
    streamingReasoning: "",
    busy: false,
    thinkingMode: "summary" as const,
    expandedThinking: [],
    width: WIDTH,
    maxMessages: Number.MAX_SAFE_INTEGER,
  };
  bench(`cold buildBlocks (no cache)`, () => estimateViewportContentHeight(noCache), 50);

  // 2. Cached hot path: same array reference, streaming-only change.
  const cache = new MessageHeightCache();
  const cachedOpts = {
    ...noCache,
    cache,
    subagentById: {},
    subagentRevision: 0,
    toolById: {},
    toolRevision: 0,
  };
  bench(`cached estimateViewportContentHeight (hot path)`, () => estimateViewportContentHeight(cachedOpts));

  // 3. Append a message → new array reference, per-message WeakMap hits.
  let appendIdx = 0;
  const cache2 = new MessageHeightCache();
  prime(cache2, { messages, subagentById: {}, toolById: {} }); // prime
  const cacheOpts2 = { ...noCache, cache: cache2, subagentById: {}, subagentRevision: 0, toolById: {}, toolRevision: 0 };
  bench(`append walk (new array, N-1 cached msgs)`, () => {
    appendIdx++;
    const next = [...cacheOpts2.messages, { kind: "user", text: `append ${appendIdx}` } as ChatMessage];
    return estimateViewportContentHeight({ ...cacheOpts2, messages: next });
  }, 100);

  // 4. Subagent revision bump that breaks the incremental path (map reference +
  //    revision jump > 1) → forced full O(N) rebuild under cache.
  const cache3 = new MessageHeightCache();
  let rev = 0;
  let mapId = 0;
  prime(cache3, { messages, subagentById: {}, toolById: {} }); // prime
  bench("subagent invalidation → full cached rebuild", () => {
    rev += 2; // jump by 2 so incremental single-change path cannot apply
    mapId++;
    const subagentById = { [mapId]: {} as never };
    return estimateViewportContentHeight({
      ...cacheOpts2,
      cache: cache3,
      subagentById,
      subagentRevision: rev,
      subagentChange: { id: String(mapId), index: 0, revision: rev },
    });
  }, 100);

  // 5. Viewport selection (binary search over prefix heights + O(visible)).
  const cache4 = new MessageHeightCache();
  prime(cache4, { messages, subagentById: {}, toolById: {} });
  bench("selectMessageViewport (height=30 window)", () =>
    selectMessageViewport({ ...cachedOpts, cache: cache4, scrollOffset: 0, availableHeight: 30 }));

  // 6. Streaming live-stack work per flush: stripInlineMarkdown + row count on
  //    the 16K-char capped preview (reproduces getStreamingDisplayText cost).
  const streamingText = markdownBlock(0, 500).repeat(4).slice(0, 16_000);
  const cache5 = new MessageHeightCache();
  bench("streaming live block (16K text, per 80ms flush)", () =>
    estimateViewportActualHeight({ ...cachedOpts, cache: cache5, streamingText, busy: true }), 500);
}

// Reference: the terminal-side per-frame diff cost is O(visible lines) and the
// reducer hot paths were verified to be O(1)/O(delta) in code review.
