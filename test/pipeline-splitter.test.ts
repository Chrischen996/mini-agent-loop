/**
 * Requirement splitter (M2) tests — faux-LLM conventions: dummy LLM config
 * (model "faux") plus an injected faux `chat` that returns canned replies
 * in order (one reply per re-split round).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { contentAsString } from "../src/content.ts";
import { makeLlmConfig, type ChatFn } from "../src/llm/index.ts";
import type { AgentMessage, AssistantMessage } from "../src/types.ts";
import type { Tool, ToolResult } from "../src/tools/types.ts";
import {
  analyzeRequirement,
  buildSplitPrompt,
  extractLastJsonArray,
} from "../src/orchestration/pipeline/splitter.ts";
import type { PipelineLogEvent, TaskSpec } from "../src/orchestration/pipeline/types.ts";

// ─── Shared helpers ──────────────────────────────────────────────────────────

const dummyLlm = makeLlmConfig({
  apiKey: "test-key",
  baseUrl: "http://localhost/v1",
  model: "faux",
});

function createEchoTool(): Tool {
  return {
    name: "echo",
    description: "echoes back the input",
    parameters: { type: "object", properties: { message: { type: "string" } } },
    execute: async (args: Record<string, unknown>): Promise<ToolResult> => ({
      content: `echo: ${args.message}`,
    }),
  };
}

/** Fenced JSON-array reply the analyzer subagent can return. */
function specArrayText(specs: Array<Record<string, unknown>>): string {
  return "```json\n" + JSON.stringify(specs, null, 2) + "\n```";
}

/**
 * One faux chat serving the analyzer subagent across re-split rounds:
 * replies are consumed in call order; the last reply repeats.
 */
function createSplitChat(replies: string[]): ChatFn {
  let call = 0;
  return async (_config, messages: AgentMessage[]): Promise<AssistantMessage> => {
    const reply = replies[Math.min(call, replies.length - 1)];
    call += 1;
    void messages;
    return { role: "assistant", content: reply };
  };
}

function makeAnalyzer(chat: ChatFn, extra: Record<string, unknown> = {}) {
  return {
    parentLlm: dummyLlm,
    parentTools: [createEchoTool()] as Tool[],
    chat,
    ...extra,
  };
}

// ─── Prompt builder ──────────────────────────────────────────────────────────

describe("buildSplitPrompt", () => {
  it("embeds the requirement, background and task cap", () => {
    const prompt = buildSplitPrompt("add login", "FastAPI project", 8);
    assert.ok(prompt.includes("add login"));
    assert.ok(prompt.includes("FastAPI project"));
    assert.ok(prompt.includes("Total tasks <= 8"));
    assert.ok(prompt.includes("JSON array"));
  });

  it("requires import-safe acceptance for new modules", () => {
    const prompt = buildSplitPrompt("add a module", "", 8);
    assert.ok(prompt.includes("Import safety"));
    assert.ok(prompt.includes("imports cleanly with no side effects"));
    assert.ok(prompt.includes("process.argv[1]"));
  });

  it("appends feedback on re-split rounds", () => {
    const prompt = buildSplitPrompt("add login", "", 8, "T-01: no executable acceptance criteria");
    assert.ok(prompt.includes("Previous round failed self-check"));
    assert.ok(prompt.includes("T-01: no executable acceptance criteria"));
  });
});

// ─── JSON array extraction ───────────────────────────────────────────────────

describe("extractLastJsonArray", () => {
  it("prefers the last fenced JSON array", () => {
    const text = "first ```json\n[{\"a\": 1}]\n``` later ```json\n[{\"b\": 2}]\n``` end";
    assert.deepEqual(extractLastJsonArray(text), [{ b: 2 }]);
  });

  it("falls back to balanced-bracket scanning for bare arrays", () => {
    const text = 'preamble [{"id": "T-01", "nested": {"x": [1, 2]}}] tail';
    assert.deepEqual(extractLastJsonArray(text), [{ id: "T-01", nested: { x: [1, 2] } }]);
  });

  it("skips unparseable candidates", () => {
    const text = "```json\n[broken\n``` and then [{\"ok\": true}]";
    assert.deepEqual(extractLastJsonArray(text), [{ ok: true }]);
  });

  it("returns undefined when no array is present", () => {
    assert.equal(extractLastJsonArray("no json here"), undefined);
  });
});

// ─── analyzeRequirement ──────────────────────────────────────────────────────

describe("analyzeRequirement", () => {
  it("parses a clean spec set on the first round", async () => {
    const chat = createSplitChat([
      specArrayText([
        {
          id: "T-001",
          title: "task one",
          instruction: "do A",
          acceptance: ["A works"],
          files_hint: ["src/a.ts"],
          model_hint: "light",
        },
        {
          instruction: "do B", // no id → normalized
          acceptance: ["B works"],
          files_hint: ["src/b.ts"],
        },
      ]),
    ]);
    const { specs, resplits } = await analyzeRequirement("requirement", makeAnalyzer(chat));
    assert.equal(resplits, 0);
    assert.equal(specs.length, 2);
    assert.equal(specs[0].id, "T-001");
    assert.equal(specs[0].model_hint, "light");
    assert.equal(specs[1].id, "T-02"); // assigned when missing (1-based index)
    assert.equal(specs[1].context, "");
  });

  it("drops invalid model_hint values", async () => {
    const chat = createSplitChat([
      specArrayText([{ instruction: "do A", acceptance: ["x"], model_hint: "quantum" }]),
    ]);
    const { specs } = await analyzeRequirement("r", makeAnalyzer(chat));
    assert.equal(specs[0].model_hint, undefined);
  });

  it("re-splits when acceptance criteria are missing", async () => {
    const chat = createSplitChat([
      specArrayText([{ id: "T-001", instruction: "do A" }]), // no acceptance
      specArrayText([{ id: "T-001", instruction: "do A", acceptance: ["A works"] }]),
    ]);
    const { specs, resplits } = await analyzeRequirement("r", makeAnalyzer(chat));
    assert.equal(resplits, 1);
    assert.equal(specs[0].acceptance.length, 1);
  });

  it("re-splits when the task count exceeds maxTasks", async () => {
    const chat = createSplitChat([
      specArrayText(
        [0, 1, 2].map((i) => ({ id: `T-${i}`, instruction: `i${i}`, acceptance: ["ok"] })),
      ),
      specArrayText([0, 1].map((i) => ({ id: `T-${i}`, instruction: `i${i}`, acceptance: ["ok"] }))),
    ]);
    const { specs, resplits } = await analyzeRequirement("r", makeAnalyzer(chat, { maxTasks: 2 }));
    assert.equal(resplits, 1);
    assert.equal(specs.length, 2);
  });

  it("throws after exhausting re-split rounds on a dependency cycle", async () => {
    const cyclic = specArrayText([
      { id: "A", instruction: "a", acceptance: ["ok"], depends_on: ["B"] },
      { id: "B", instruction: "b", acceptance: ["ok"], depends_on: ["A"] },
    ]);
    const chat = createSplitChat([cyclic, cyclic, cyclic, cyclic]);
    await assert.rejects(
      () => analyzeRequirement("r", makeAnalyzer(chat, { maxResplitRounds: 2 })),
      /cycle/i,
    );
  });

  it("throws when the reply is unparseable on every round", async () => {
    const chat = createSplitChat(["no json at all"]);
    await assert.rejects(
      () => analyzeRequirement("r", makeAnalyzer(chat, { maxResplitRounds: 1 })),
      /unparseable split result/,
    );
  });

  it("emits a split event with the task count on success", async () => {
    const events: PipelineLogEvent[] = [];
    const chat = createSplitChat([
      specArrayText([{ id: "T-001", instruction: "do A", acceptance: ["ok"] }]),
    ]);
    await analyzeRequirement("r", makeAnalyzer(chat, { onEvent: (e: PipelineLogEvent) => events.push(e) }));
    const split = events.find((e) => e.event === "split");
    assert.ok(split !== undefined);
    assert.equal(split!.task_id, "split");
    assert.equal(split!.tasks, 1);
    assert.equal(split!.round, 1);
  });
});

// ─── Spec-set helpers (shared shape used by the M3 tests below) ─────────────

export function spec(id: string, files_hint: string[] = [], depends_on?: string[]): TaskSpec {
  return {
    id,
    title: id,
    context: "",
    instruction: "work",
    acceptance: ["done"],
    files_hint,
    ...(depends_on !== undefined ? { depends_on } : {}),
  };
}
