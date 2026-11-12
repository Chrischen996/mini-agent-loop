import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildSealedStaticItems,
  isSealableTranscriptMessage,
  sealedTranscriptCount,
  selectMessageViewport,
  MessageHeightCache,
} from "../src/tui/message-viewport.ts";
import type { ChatMessage } from "../src/tui/state.ts";

const user = (text: string): ChatMessage => ({ kind: "user", text });
const assistant = (text: string): ChatMessage => ({ kind: "assistant", text });
const tool = (id: string, status: "running" | "done"): Extract<ChatMessage, { kind: "tool_call" }> => ({
  kind: "tool_call",
  id,
  name: "bash",
  args: "{}",
  rawArgs: {},
  status,
  startedAt: 0,
});
const subagent = (id: string, status: "running" | "done"): ChatMessage => ({
  kind: "subagent_call",
  id,
  task: "research",
  depth: 0,
  status,
  innerEvents: [],
  toolCallCount: 0,
  startedAt: 0,
  expanded: false,
});

describe("sealed transcript prefix", () => {
  it("seals immutable kinds and finished tool cards", () => {
    assert.equal(isSealableTranscriptMessage(user("hi")), true);
    assert.equal(isSealableTranscriptMessage({ kind: "notice", text: "n" }), true);
    assert.equal(isSealableTranscriptMessage({ kind: "error", text: "e" }), true);
    assert.equal(isSealableTranscriptMessage(assistant("done")), true);
    assert.equal(isSealableTranscriptMessage(tool("t", "done")), true);
    assert.equal(isSealableTranscriptMessage(tool("t", "running")), false);
  });

  it("never seals subagent cards (interactive expand/collapse)", () => {
    assert.equal(isSealableTranscriptMessage(subagent("s", "running")), false);
    assert.equal(isSealableTranscriptMessage(subagent("s", "done")), false);
  });

  it("honors overlay status when deciding sealability", () => {
    const base = tool("t", "running");
    const overlays = { toolById: { t: tool("t", "done") } };
    assert.equal(isSealableTranscriptMessage(base, overlays), true);
  });

  it("computes the longest sealable prefix", () => {
    const messages = [user("q"), assistant("a"), tool("t", "done"), tool("t2", "running"), assistant("late")];
    assert.equal(sealedTranscriptCount(messages), 3);
    assert.equal(sealedTranscriptCount([]), 0);
    assert.equal(sealedTranscriptCount([subagent("s", "done")]), 0);
  });

  it("builds static items for the sealed prefix with stable identity", () => {
    const cache = new MessageHeightCache();
    const messages = [user("q1"), assistant("a1"), tool("t", "running"), assistant("a2")];
    const options = {
      width: 40,
      thinkingMode: "hidden" as const,
      expandedThinking: [] as number[],
      subagentById: {},
      toolById: {} as Record<string, Extract<ChatMessage, { kind: "tool_call" }>>,
      subagentRevision: 0,
      toolRevision: 0,
      cache,
    };
    const first = buildSealedStaticItems({ messages, ...options });
    assert.equal(first.sealedCount, 2);
    assert.equal(first.items.length, 2);
    assert.ok(first.items[0]!.rows.length > 0);
    assert.ok(first.items[1]!.rows.length > 0);

    // Unchanged inputs → identical items array (no re-emission downstream).
    const second = buildSealedStaticItems({ messages, ...options });
    assert.equal(second.items, first.items);

    // A done-tool overlay seals the tool card AND the trailing assistant.
    const grown = buildSealedStaticItems({
      messages,
      ...options,
      toolById: { t: tool("t", "done") },
      toolRevision: 1,
    });
    assert.equal(grown.sealedCount, 4);
    assert.equal(grown.items.length, 4);
    assert.equal(grown.items[0]!.rows, first.items[0]!.rows, "sealed rows reuse the shared cache");
  });

  it("extends the prefix when the transcript array grows", () => {
    const cache = new MessageHeightCache();
    const base = [user("q"), assistant("a")] as ChatMessage[];
    const options = { width: 40, thinkingMode: "hidden" as const, expandedThinking: [] as number[], cache };
    const first = buildSealedStaticItems({ messages: base, ...options });
    assert.equal(first.sealedCount, 2);
    const next = [...base, user("q2")];
    const second = buildSealedStaticItems({ messages: next, ...options });
    assert.equal(second.sealedCount, 3);
    assert.equal(second.items.length, 3);
    assert.equal(second.items[0]!.rows, first.items[0]!.rows);
    assert.equal(second.items[1]!.rows, first.items[1]!.rows);
  });

  it("excludes the sealed prefix from viewport scroll accounting", () => {
    const messages = [user("line one"), user("line two"), user("line three")] as ChatMessage[];
    const base = {
      streamingText: "",
      streamingReasoning: "",
      busy: false,
      thinkingMode: "hidden" as const,
      expandedThinking: [] as number[],
      scrollOffset: 0,
      availableHeight: 100,
      width: 40,
      showHistoryHints: false,
    };
    const full = selectMessageViewport({ messages, ...base });
    const excluded = selectMessageViewport({ messages, ...base, historyStartIndex: 2 });
    assert.ok(full.totalHeight > excluded.totalHeight, "sealed rows must not be re-accounted");
    const kinds = excluded.items.filter((item) => item.kind === "message") as Array<{ index: number }>;
    assert.ok(kinds.length > 0);
    for (const item of kinds) assert.ok(item.index >= 2, "dynamic frame only renders unsealed messages");
  });
});
