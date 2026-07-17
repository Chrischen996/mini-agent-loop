import process from "node:process";
import { contentAsString } from "../content.ts";
import { loadLlmConfigFromEnv } from "../llm.ts";
import {
  createAgentHistory,
  runAgentTurn,
  type LoopEvent,
} from "../loop.ts";
import {
  createVisionPreprocessor,
  loadVisionConfigFromEnv,
} from "../preprocessors/index.ts";
import { createDefaultTools } from "../tools/index.ts";
import type { AgentMessage } from "../types.ts";

type ToolView = {
  id: string;
  name: string;
  status: "running" | "done" | "error";
  preview?: string;
};

type TuiState = {
  history: AgentMessage[];
  streamingText: string;
  tools: ToolView[];
  busy: boolean;
  input: string;
  pendingUser?: string;
  status: string;
};

const ANSI = {
  alternateScreen: "\x1b[?1049h",
  mainScreen: "\x1b[?1049l",
  clear: "\x1b[2J\x1b[H",
  hideCursor: "\x1b[?25l",
  showCursor: "\x1b[?25h",
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
};

function short(value: string, max = 160): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}...` : oneLine;
}

function render(state: TuiState): void {
  const lines: string[] = [
    `${ANSI.cyan}mini-agent TUI${ANSI.reset} ${ANSI.dim}(Ctrl+C 退出，输入 /clear 清空会话)${ANSI.reset}`,
    "",
  ];

  for (const message of state.history.filter((item) => item.role !== "system")) {
    if (message.role === "user") lines.push(`${ANSI.green}> ${ANSI.reset}${contentAsString(message.content)}`);
    if (message.role === "assistant" && message.content) lines.push(`${ANSI.cyan}assistant:${ANSI.reset} ${message.content}`);
    if (message.role === "tool") lines.push(`${ANSI.dim}[${message.name}] ${short(contentAsString(message.content))}${ANSI.reset}`);
  }

  if (state.pendingUser) lines.push(`${ANSI.green}> ${ANSI.reset}${state.pendingUser}`);

  if (state.streamingText) {
    lines.push(`${ANSI.cyan}assistant:${ANSI.reset} ${state.streamingText}`);
  }
  for (const tool of state.tools.slice(-4)) {
    const icon = tool.status === "running" ? `${ANSI.yellow}*` : tool.status === "error" ? `${ANSI.red}!` : `${ANSI.green}ok`;
    lines.push(`${icon}${ANSI.reset} ${tool.name}${tool.preview ? ` ${ANSI.dim}${short(tool.preview, 100)}${ANSI.reset}` : ""}`);
  }

  lines.push("", `${ANSI.dim}${state.status}${ANSI.reset}`, `${state.busy ? "" : "> "}${state.input}`);
  // Redraw inside the alternate screen so raw-mode keystrokes replace the frame.
  process.stdout.write(`${ANSI.clear}${lines.join("\n")}`);
}

function handleEvent(state: TuiState, event: LoopEvent): void {
  switch (event.type) {
    case "assistant_delta":
      state.streamingText += event.text;
      state.status = "模型输出中...";
      break;
    case "assistant":
      state.streamingText = "";
      state.status = event.message.toolCalls?.length ? "准备执行工具..." : "";
      break;
    case "tool_start":
      state.tools.push({ id: event.call.id, name: event.call.name, status: "running" });
      state.status = `正在执行 ${event.call.name}...`;
      break;
    case "tool_end": {
      const current = state.tools.find((tool) => tool.id === event.call.id);
      if (current) {
        current.status = event.result.isError ? "error" : "done";
        current.preview = short(contentAsString(event.result.content), 100);
      }
      state.status = event.result.isError ? `${event.call.name} 执行失败` : `${event.call.name} 已完成`;
      break;
    }
    case "permission_required":
      state.status = `等待权限确认: ${event.request.tool}`;
      break;
    case "aborted":
      state.streamingText = "";
      state.busy = false;
      state.status = "已停止";
      break;
    case "done":
      state.busy = false;
      state.status = "就绪";
      break;
  }
}

async function main(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("TUI requires an interactive terminal");
  }

  const cwd = process.cwd();
  const llm = loadLlmConfigFromEnv();
  const vision = loadVisionConfigFromEnv();
  const state: TuiState = {
    history: createAgentHistory(),
    streamingText: "",
    tools: [],
    busy: false,
    input: "",
    pendingUser: undefined,
    status: "就绪",
  };
  const abortController = new AbortController();
  const tools = createDefaultTools(cwd);
  let screenActive = false;

  const cleanup = () => {
    if (!screenActive) return;
    screenActive = false;
    if (process.stdin.isRaw) process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write(`${ANSI.showCursor}${ANSI.mainScreen}`);
  };
  const quit = () => {
    abortController.abort();
    cleanup();
    process.exit(0);
  };

  process.stdout.write(`${ANSI.alternateScreen}${ANSI.hideCursor}`);
  screenActive = true;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  process.on("SIGINT", quit);
  process.on("exit", cleanup);

  const submit = async (prompt: string) => {
    const text = prompt.trim();
    if (!text || state.busy) return;
    if (text === "/exit" || text === "/quit") return quit();
    if (text === "/clear") {
      state.history = createAgentHistory();
      state.tools = [];
      state.status = "已清空会话";
      render(state);
      return;
    }

    state.input = "";
    state.pendingUser = text;
    state.streamingText = "";
    state.busy = true;
    state.status = "请求模型中...";
    render(state);
    try {
      state.history = await runAgentTurn(state.history, text, {
        llm,
        tools,
        preprocessors: vision ? [createVisionPreprocessor(vision)] : [],
        signal: abortController.signal,
        onEvent: (event) => {
          handleEvent(state, event);
          render(state);
        },
      });
      state.pendingUser = undefined;
    } catch (error) {
      state.pendingUser = undefined;
      state.busy = false;
      state.status = `错误: ${error instanceof Error ? error.message : String(error)}`;
      render(state);
    }
  };

  process.stdin.on("data", (chunk: string) => {
    for (const char of chunk) {
      if (char === "\u0003") return quit();
      if (char === "\r" || char === "\n") {
        void submit(state.input);
        continue;
      }
      if (char === "\u007f") {
        state.input = state.input.slice(0, -1);
        render(state);
        continue;
      }
      if (char >= " " && char !== "\u007f") {
        state.input += char;
        render(state);
      }
    }
  });

  render(state);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
