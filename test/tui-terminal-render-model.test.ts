import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTerminalRenderLines } from "../src/tui/terminal-render-model.ts";
import { permissionPanelRenderLines, planApprovalRenderLines } from "../src/tui/terminal-overlay-lines.ts";
import { createInitialState, tuiReducer } from "../src/tui/state.ts";
import { terminalStringWidth, truncateTerminalPath } from "../src/tui/terminal-width.ts";
import { displaySubagentTask, isSubagentProtocolText, isSubagentToolName, subagentRenderLines } from "../src/tui/subagent-lines.ts";

describe("standalone terminal render model", () => {
  it("keeps the final path segments visible when compacting cwd", () => {
    const compact = truncateTerminalPath("/Users/chenjiaxu/Project/agent loop/mini-agent", 24);
    assert.equal(compact, "…/agent loop/mini-agent");
    assert.ok(terminalStringWidth(compact) <= 24);
  });

  it("projects chat state without mutating the reducer state", () => {
    let state = createInitialState("test-model");
    state = tuiReducer(state, { type: "USER_MESSAGE", text: "hello" });
    state = tuiReducer(state, { type: "LOOP_EVENT", event: { type: "assistant_delta", text: "answer", kind: "answer" } });
    state = tuiReducer(state, { type: "SET_STATUS", status: "就绪" });
    const before = structuredClone(state);

    const lines = buildTerminalRenderLines(state);

    assert.ok(lines.some((line) => line.text.includes("hello")));
    assert.ok(lines.some((line) => line.text.includes("answer")));
    assert.deepEqual(state, before);
  });

  it("keeps a stable key for unchanged line identities", () => {
    const state = createInitialState("test-model");
    const first = buildTerminalRenderLines(state);
    const second = buildTerminalRenderLines(state);
    assert.deepEqual(first, second);
  });

  it("marks the focused reasoning message in the terminal rows", () => {
    let state = createInitialState("test-model");
    state = tuiReducer(state, { type: "USER_MESSAGE", text: "question" });
    state = tuiReducer(state, { type: "LOOP_EVENT", event: { type: "assistant", message: { role: "assistant", content: "answer" } } });
    state = tuiReducer(state, { type: "LOOP_EVENT", event: { type: "assistant_delta", text: "reasoning", kind: "reasoning" } });
    state = tuiReducer(state, { type: "LOOP_EVENT", event: { type: "assistant", message: { role: "assistant", content: "" } } });
    state = tuiReducer(state, { type: "SET_FOCUSED_MESSAGE", index: 2 });

    const lines = buildTerminalRenderLines(state);
    assert.ok(lines.some((line) => line.text === "◆ "));
    assert.ok(lines.some((line) => line.prefix === "│ "));
    assert.ok(lines.some((line) => line.tone === "running" && line.text.includes("reasoning")));
  });

  it("wraps and clips the body while keeping status and input visible", () => {
    let state = createInitialState("test-model");
    state = tuiReducer(state, { type: "USER_MESSAGE", text: "one two three four" });
    state = tuiReducer(state, { type: "LOOP_EVENT", event: { type: "assistant_delta", text: "long response", kind: "answer" } });
    const lines = buildTerminalRenderLines(state, {
      width: 10,
      height: 4,
      input: "go",
      cursor: 1,
    });

    assert.ok(lines.length <= 4);
    assert.equal(lines.at(-1)?.key, "input-0");
    assert.ok(lines.some((line) => line.text.includes("g▌o")));
  });

  it("uses an empty gutter on wrapped continuation rows", () => {
    let state = createInitialState("test-model");
    state = tuiReducer(state, { type: "USER_MESSAGE", text: "a long prompt" });
    const lines = buildTerminalRenderLines(state, { width: 10 });
    const promptRows = lines.filter((line) => line.key === "message-0" || line.key.startsWith("message-0-w"));
    assert.ok(promptRows.length > 1);
    assert.equal(promptRows[0]?.prefix, "❯ ");
    assert.equal(promptRows[1]?.prefix, "  ");
  });

  it("wraps multiline input without repeating the prompt marker", () => {
    const state = createInitialState("test-model");
    const lines = buildTerminalRenderLines(state, { width: 10, input: "0123456789abc" });
    const inputRows = lines.filter((line) => line.key === "input-0" || line.key.startsWith("input-0-w"));
    assert.ok(inputRows.length > 1);
    assert.equal(inputRows[0]?.prefix, "❯ ");
    assert.equal(inputRows[1]?.prefix, "  ");
  });

  it("keeps the Todo panel pinned while history scrolls", () => {
    let state = createInitialState("test-model");
    state = tuiReducer(state, {
      type: "SET_TODO_ITEMS",
      revision: 1,
      todos: [{ id: "task-1", content: "inspect", activeForm: "inspecting", status: "in_progress", source: "model" }],
    });
    state = tuiReducer(state, { type: "USER_MESSAGE", text: "history" });
    state = tuiReducer(state, { type: "SCROLL_BY", delta: 3 });
    const lines = buildTerminalRenderLines(state, { height: 5, input: "" });
    assert.equal(lines[0]?.key, "panel-todo-header");
  });

  it("masks API keys while the model setup overlay owns the input", () => {
    const state = createInitialState("test-model");
    const lines = buildTerminalRenderLines(state, {
      input: "secret-key",
      cursor: 6,
      maskInput: true,
    });
    const input = lines.find((line) => line.key === "input-0");
    assert.equal(input?.text, "******▌****");
    assert.ok(!lines.some((line) => line.text.includes("secret-key")));
  });

  it("keeps pending image attachments visible above the prompt", () => {
    let state = createInitialState("test-model");
    state = tuiReducer(state, {
      type: "ADD_PENDING_IMAGE",
      image: { path: "/tmp/diagram.png", mimeType: "image/png" },
    });
    const lines = buildTerminalRenderLines(state, { input: "" });
    const image = lines.find((line) => line.key === "pending-image-0");
    assert.equal(image?.text, "diagram.png");
    assert.equal(lines.at(-1)?.key, "input-0");
  });

  it("projects the Claude Code conversation chrome without changing the default model", () => {
    let state = createInitialState("claude-sonnet");
    state = tuiReducer(state, { type: "USER_MESSAGE", text: "hello" });
    state = tuiReducer(state, { type: "LOOP_EVENT", event: { type: "assistant", message: { role: "assistant", content: "answer" } } });

    const lines = buildTerminalRenderLines(state, {
      width: 100,
      header: { title: "Claude Code", cwd: "/workspace" },
      promptRule: true,
      input: "next",
    });

    assert.equal(lines[0]?.key, "header-title");
    assert.equal(lines[0]?.text, "Claude Code");
    assert.equal(lines[0]?.prefix, "✻ ");
    assert.equal(lines.find((line) => line.key.startsWith("message-0"))?.prefix, "❯ ");
    assert.equal(lines.find((line) => line.key.startsWith("message-0"))?.background, "user");
    assert.equal(lines.find((line) => line.key.startsWith("message-1"))?.prefix, "⏺ ");
    assert.ok(lines.some((line) => line.key.startsWith("message-gap-")));
    assert.equal(lines.find((line) => line.key === "prompt-rule")?.text.length, 100);
    assert.equal(lines.find((line) => line.key === "status")?.prefix, "⟳ ");
    assert.match(lines.find((line) => line.key === "status")?.text ?? "", /claude-sonnet · \/workspace · Plan mode · Working…/);
  });

  it("keeps model and cwd out of the optional title row", () => {
    const state = createInitialState("claude-sonnet");
    const lines = buildTerminalRenderLines(state, { header: { title: "Claude Code", cwd: "/workspace" } });
    assert.deepEqual(lines.filter((line) => line.key.startsWith("header-")), [
      { key: "header-title", text: "Claude Code", prefix: "✻ ", style: "assistant", bold: true, tone: "running" },
    ]);
  });

  it("renders tool output as a nested Claude-style activity row", () => {
    let state = createInitialState("test-model");
    state = tuiReducer(state, { type: "USER_MESSAGE", text: "inspect" });
    state = tuiReducer(state, { type: "LOOP_EVENT", event: { type: "tool_start", call: { id: "tool-1", name: "read", arguments: { path: "src/app.tsx" } } } });
    state = tuiReducer(state, { type: "LOOP_EVENT", event: { type: "tool_end", call: { id: "tool-1", name: "read", arguments: { path: "src/app.tsx" } }, result: { content: "line one\nline two", isError: false } } });
    const lines = buildTerminalRenderLines(state);
    const tool = lines.find((line) => line.key.endsWith("-tool"));
    assert.match(tool?.text ?? "", /Read\(src\/app\.tsx\)/);
    assert.equal(tool?.prefix, "⏺ ");
    assert.equal(lines.find((line) => line.key.endsWith("-result-0"))?.prefix, "  ⎿ ");
  });

  it("renders completed tools as full-width cards when terminal width is known", () => {
    let state = createInitialState("test-model");
    state = tuiReducer(state, { type: "LOOP_EVENT", event: { type: "tool_start", call: { id: "tool-1", name: "read", arguments: { path: "src/app.tsx" } } } });
    state = tuiReducer(state, { type: "LOOP_EVENT", event: { type: "tool_end", call: { id: "tool-1", name: "read", arguments: { path: "src/app.tsx" } }, result: { content: "line one\nline two", isError: false } } });
    const width = 36;
    const lines = buildTerminalRenderLines(state, { width });
    const card = lines.filter((line) => line.key.includes("message-0-tool") || line.key.includes("message-0-result"));
    assert.ok(card.length >= 4);
    for (const line of card) assert.equal(terminalStringWidth(`${line.prefix ?? ""}${line.text}`), width);
    assert.equal(card[0]?.text.at(0), "╭");
    assert.equal(card.at(-1)?.text.at(-1), "╯");
  });

  it("uses append-only transcript rows and a live tail in scrollback mode", () => {
    let state = createInitialState("test-model");
    state = tuiReducer(state, { type: "USER_MESSAGE", text: "inspect" });
    state = tuiReducer(state, { type: "LOOP_EVENT", event: { type: "tool_start", call: { id: "tool-1", name: "read", arguments: { path: "src/app.tsx" } } } });

    const lines = buildTerminalRenderLines(state, {
      width: 40,
      scrollback: true,
      header: { title: "Claude Code", cwd: "/workspace" },
      input: "",
    });

    const firstLive = lines.findIndex((line) => line.ephemeral);
    assert.ok(firstLive > 0);
    assert.equal(lines.slice(0, firstLive).some((line) => line.text.at(0) === "╭"), false);
    assert.equal(lines.find((line) => line.key === "message-1-tool")?.prefix, "⏺ ");
    assert.ok(lines.slice(firstLive).every((line) => line.ephemeral));
  });

  it("keeps the complete transcript in scrollback mode beyond the fullscreen cap", () => {
    let state = createInitialState("test-model");
    for (let index = 0; index < 205; index++) {
      state = tuiReducer(state, { type: "USER_MESSAGE", text: `message-${index}` });
    }

    const lines = buildTerminalRenderLines(state, { scrollback: true, input: "" });
    assert.ok(lines.some((line) => line.text.includes("message-0")));
    assert.ok(lines.some((line) => line.text.includes("message-204")));
    assert.equal(lines.filter((line) => line.text.includes("message-0")).length, 1);
  });

  it("truncates oversized user prompts with head and tail context", () => {
    const prompt = `${"head\n".repeat(900)}${"middle\n".repeat(900)}${"tail\n".repeat(900)}`;
    let state = createInitialState("test-model");
    state = tuiReducer(state, { type: "USER_MESSAGE", text: prompt });

    const user = buildTerminalRenderLines(state, { scrollback: true }).find((line) => line.key === "message-0");
    assert.ok(user);
    assert.match(user.text, /head/);
    assert.match(user.text, /tail/);
    assert.match(user.text, /\+\d+ lines/);
    assert.ok(user.text.length < prompt.length);
  });

  it("moves Todo updates into the live tail without blocking transcript history", () => {
    let state = createInitialState("test-model");
    state = tuiReducer(state, {
      type: "SET_TODO_ITEMS",
      revision: 1,
      todos: [{ id: "task-1", content: "inspect", activeForm: "inspecting", status: "in_progress", source: "model" }],
    });
    state = tuiReducer(state, { type: "USER_MESSAGE", text: "history" });

    const lines = buildTerminalRenderLines(state, { width: 40, scrollback: true, input: "" });
    const firstLive = lines.findIndex((line) => line.ephemeral);
    assert.ok(firstLive > 0);
    assert.ok(lines.slice(firstLive).some((line) => line.key.startsWith("panel-")));
    assert.ok(lines.slice(0, firstLive).some((line) => line.text.includes("history")));
  });

  it("renders permission and plan overlays as English bordered cards", () => {
    const permission = permissionPanelRenderLines({ requestId: "p", sessionId: "s", tool: "bash", arguments: { command: "npm test" }, risk: "high" });
    assert.equal(permission[0]?.prefix, "╭─ ");
    assert.match(permission.map((line) => line.text).join(" "), /Permission required.*npm test.*Do you want to proceed\?.*Allow.*Deny/);
    const plan = planApprovalRenderLines({ id: "p", sessionId: "s", createdAt: 0, summary: "Run checks", steps: [{ id: "s1", order: 1, description: "Run tests", tool: "bash", arguments: {}, risk: "safe", rationale: "verify", status: "pending" }], risks: [], requiredTools: [], status: "pending_review" });
    assert.match(plan.map((line) => line.text).join(" "), /Plan approval.*Run checks.*Approve.*Reject/);
    assert.equal(plan.at(-1)?.prefix, "╰─ ");
  });

  it("keeps full-width card borders stable on the terminal path", () => {
    const width = 32;
    const permission = permissionPanelRenderLines({ requestId: "p", sessionId: "s", tool: "bash", arguments: { command: "npm test" }, risk: "high" }, width);
    const plan = planApprovalRenderLines({ id: "p", sessionId: "s", createdAt: 0, summary: "Run checks", steps: [], risks: [], requiredTools: [], status: "pending_review" }, width);
    for (const line of [...permission, ...plan]) assert.equal(terminalStringWidth(`${line.prefix ?? ""}${line.text}`), width);
    assert.equal(permission[0]?.text.at(0), "╭");
    assert.equal(permission.at(-1)?.text.at(-1), "╯");
  });

  it("keeps the Claude chrome within a short terminal frame", () => {
    const state = createInitialState("test-model");
    const lines = buildTerminalRenderLines(state, {
      width: 20,
      height: 4,
      header: { title: "Claude Code", cwd: "/tmp" },
      promptRule: true,
      input: "go",
    });

    assert.ok(lines.length <= 4);
    assert.equal(lines.at(-1)?.key, "input-0");
  });

  it("fills the frame and pins the prompt to the requested height", () => {
    const state = createInitialState("test-model");
    const lines = buildTerminalRenderLines(state, {
      width: 30,
      height: 10,
      header: { title: "Claude Code", cwd: "/tmp" },
      promptRule: true,
      input: "go",
    });

    assert.equal(lines.length, 10);
    assert.equal(lines.at(-1)?.key, "input-0");
    assert.ok(lines.some((line) => line.key.startsWith("frame-spacer-")));
  });

  it("truncates long status context without adding a wrapped status row", () => {
    const state = createInitialState("very-long-model-name");
    const lines = buildTerminalRenderLines(state, {
      width: 20,
      height: 8,
      header: { title: "Claude Code", cwd: "/Users/chenjiaxu/Project/agent loop/mini-agent" },
      promptRule: true,
      input: "",
    });
    const status = lines.find((line) => line.key === "status");
    assert.ok(status);
    assert.ok(terminalStringWidth(`${status.prefix ?? ""}${status.text}`) <= 20);
    assert.match(status.text, /mini-agent|…/);
    assert.equal(lines.at(-1)?.key, "input-0");
  });

  it("does not replace clipped conversation rows with a row-count hint", () => {
    let state = createInitialState("test-model");
    for (const text of ["one", "two", "three", "four"]) {
      state = tuiReducer(state, { type: "USER_MESSAGE", text });
    }
    const lines = buildTerminalRenderLines(state, {
      width: 30,
      height: 6,
      scrollOffset: 2,
      input: "",
    });
    assert.ok(!lines.some((line) => line.text.includes("还有")));
    assert.equal(lines.at(-1)?.key, "input-0");
  });

  it("renders subagents as Claude Code progress rows instead of a card", () => {
    let state = createInitialState("test-model");
    state = tuiReducer(state, {
      type: "SUBAGENT_EVENT",
      event: {
        type: "subagent_start",
        id: "agent-1",
        task: "Inspect the workspace",
        profile: "researcher",
        depth: 1,
        runtime: {
          model: "test-model",
          provider: "faux",
          baseUrl: "http://localhost",
          thinkingMode: "fixed",
          modelSwitchSucceeded: true,
        },
      },
    });
    state = tuiReducer(state, {
      type: "SUBAGENT_EVENT",
      event: {
        type: "subagent_event",
        id: "agent-1",
        depth: 1,
        inner: {
          type: "tool_start",
          call: { id: "read-1", name: "read", arguments: { path: "src/app.tsx" } },
        },
      },
    });
    state = tuiReducer(state, {
      type: "SUBAGENT_EVENT",
      event: {
        type: "subagent_event",
        id: "agent-1",
        depth: 1,
        inner: {
          type: "tool_end",
          call: { id: "read-1", name: "read", arguments: { path: "src/app.tsx" } },
          result: { content: "ok", isError: false },
        },
      },
    });

    const message = state.messages[0];
    assert.equal(message?.kind, "subagent_call");
    if (!message || message.kind !== "subagent_call") return;
    const rows = subagentRenderLines(message, 0);
    assert.match(rows[0]?.text ?? "", /researcher \(Inspect the workspace\) · 1 tool use/);
    assert.equal(rows[0]?.prefix, "⏺ ");
    assert.equal(rows[0]?.ephemeral, true);
    assert.match(rows.at(-1)?.text ?? "", /Read\(src\/app\.tsx\)/);
    assert.ok(!rows.some((row) => row.text.includes("╭") || row.text.includes("╰")));
  });

  it("hides the subagent scaffold and keeps long task titles single-line", () => {
    const task = `You are the researcher subagent for a parent orchestrator.\nGather only the key facts.\n\nUser request:\n${"inspect the workspace ".repeat(30)}`;
    const visible = displaySubagentTask(task);
    assert.doesNotMatch(visible, /You are|parent orchestrator|Gather only/);
    assert.doesNotMatch(visible, /\n/);
    assert.ok(visible.length <= 180);
  });

  it("cleans provider-normalized subagent scaffolds and namespaced tools", () => {
    const task = "You are the researcher subagent for a parent orchestrator.\r\nGather only the key facts needed for the parent to continue.\r\nDo not implement code changes.\r\n\r\nUser request：\r\nInspect the terminal layout";
    assert.equal(displaySubagentTask(task), "Inspect the terminal layout");
    assert.equal(displaySubagentTask("You are the researcher subagent.\\nUser request:\\nInspect the terminal layout"), "Inspect the terminal layout");
    assert.equal(displaySubagentTask("You are a researcher subagent\nGather only the key facts\nInspect the terminal layout"), "Inspect the terminal layout");
    assert.equal(displaySubagentTask("task=Inspect the terminal layout"), "Inspect the terminal layout");
    assert.equal(isSubagentToolName("functions.subagent"), true);
    assert.equal(isSubagentToolName("mcp.subagent_batch"), true);
    assert.equal(isSubagentToolName("assistant"), false);
  });

  it("does not truncate a normal task that mentions request syntax", () => {
    assert.equal(displaySubagentTask("Explain the request: marker in this task"), "Explain the request: marker in this task");
  });

  it("recognizes only serialized subagent calls as assistant protocol noise", () => {
    assert.equal(isSubagentProtocolText("subagent(task=Inspect files, profile=researcher)"), true);
    assert.equal(isSubagentProtocolText("functions.subagent(task=Inspect files, profile=researcher)"), true);
    assert.equal(isSubagentProtocolText("Please explain subagent(task=Inspect files)"), false);
    assert.equal(isSubagentProtocolText("The task is complete."), false);
  });

  it("uses tree connectors and compact token counts for expanded subagents", () => {
    const message = {
      kind: "subagent_call" as const,
      id: "agent-2",
      task: "Review changes",
      profile: "reviewer",
      depth: 1,
      status: "done" as const,
      totalTokens: 3200,
      durationMs: 1250,
      innerEvents: [
        { type: "tool_start", label: "▶ read", detail: '{"path":"a.ts"}' },
        { type: "tool_end", label: "✓ read", detail: "ok" },
      ],
      toolCallCount: 1,
      startedAt: 0,
      expanded: true,
    };
    const rows = subagentRenderLines(message, "x");
    assert.match(rows[0]?.text ?? "", /3\.2k tokens/);
    assert.equal(rows[1]?.prefix, "  ├─ ⎿ ");
    assert.equal(rows[2]?.prefix, "  └─ ⎿ ");

    const completedRows = subagentRenderLines({ ...message, expanded: false, result: "review complete" }, "done");
    assert.match(completedRows[1]?.text ?? "", /Done \(1 tool use · 3\.2k tokens · 1\.3s\)/);
    assert.equal(completedRows[2]?.prefix, "     ");
  });

  it("counts active tools and omits assistant bookkeeping rows", () => {
    const message = {
      kind: "subagent_call" as const,
      id: "agent-active",
      task: "Inspect files",
      profile: "researcher",
      depth: 1,
      status: "running" as const,
      innerEvents: [
        { type: "assistant" as const, label: "💬 assistant" },
        { type: "tool_start" as const, label: "▶ read", detail: '{"path":"a.ts"}' },
      ],
      toolCallCount: 0,
      startedAt: 0,
      expanded: true,
    };
    const rows = subagentRenderLines(message, "active");
    assert.match(rows[0]?.text ?? "", /1 tool use/);
    assert.ok(!rows.some((row) => row.text.includes("assistant")));
    assert.match(rows.at(-1)?.text ?? "", /Read\(a\.ts\)/);
  });

  it("does not duplicate the protocol subagent tool row", () => {
    let state = createInitialState("test-model");
    state = tuiReducer(state, {
      type: "LOOP_EVENT",
      event: {
        type: "tool_start",
        call: { id: "parent-call", name: "subagent", arguments: { task: "internal scaffold", profile: "researcher" } },
      },
    });
    state = tuiReducer(state, {
      type: "SUBAGENT_EVENT",
      event: {
        type: "subagent_start",
        id: "child-call",
        task: "You are the researcher subagent.\n\nUser request:\nCheck the upgrade list",
        profile: "researcher",
        depth: 1,
        runtime: {
          model: "test-model",
          provider: "faux",
          baseUrl: "http://localhost",
          thinkingMode: "fixed",
          modelSwitchSucceeded: true,
        },
      },
    });
    state = tuiReducer(state, {
      type: "LOOP_EVENT",
      event: { type: "assistant", message: { role: "assistant", content: "subagent(task=internal scaffold, profile=researcher)" } },
    });
    const lines = buildTerminalRenderLines(state);
    assert.equal(lines.some((line) => line.text.includes("internal scaffold")), false);
    assert.ok(lines.some((line) => line.text === "researcher (Check the upgrade list) · 0 tool uses"));
    assert.equal(lines.some((line) => /\bsubagent\s*\(/i.test(line.text)), false);
    assert.equal(lines.some((line) => /You are the researcher/i.test(line.text)), false);
    assert.equal(displaySubagentTask("You are a researcher subagent\n\nUser request:\nInspect files"), "Inspect files");
  });
});
