import React, { useReducer, useState, useCallback, useRef } from "react";
import { Box, Text, useApp, useInput, type Key } from "ink";
import Spinner from "ink-spinner";
import TextInput from "ink-text-input";
import { MessageFeed } from "./components/MessageFeed.tsx";
import { tuiReducer, createInitialState } from "./state.ts";
import {
  createAgentHistory,
  runAgentTurn,
  type LoopEvent,
} from "../loop.ts";
import { loadLlmConfigFromEnv } from "../llm.ts";
import {
  createVisionPreprocessor,
  loadVisionConfigFromEnv,
} from "../preprocessors/index.ts";
import { createDefaultTools } from "../tools/index.ts";
import type { AgentMessage } from "../types.ts";

type AppProps = {
  cwd: string;
};

export function App({ cwd }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const llm = loadLlmConfigFromEnv();
  const vision = loadVisionConfigFromEnv();
  const tools = createDefaultTools(cwd);

  const [state, dispatch] = useReducer(tuiReducer, createInitialState(llm.model));
  const [input, setInput] = useState("");
  const historyRef = useRef<AgentMessage[]>(createAgentHistory());
  const abortRef = useRef<AbortController>(new AbortController());

  const handleSubmit = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || state.busy) return;

      if (trimmed === "/exit" || trimmed === "/quit") { exit(); return; }
      if (trimmed === "/clear") {
        historyRef.current = createAgentHistory();
        dispatch({ type: "RESET" });
        setInput("");
        return;
      }

      setInput("");
      dispatch({ type: "USER_MESSAGE", text: trimmed });
      abortRef.current = new AbortController();

      try {
        historyRef.current = await runAgentTurn(historyRef.current, trimmed, {
          llm,
          tools,
          preprocessors: vision ? [createVisionPreprocessor(vision)] : [],
          signal: abortRef.current.signal,
          onEvent: (event: LoopEvent) => { dispatch({ type: "LOOP_EVENT", event }); },
        });
      } catch {
        dispatch({ type: "LOOP_EVENT", event: { type: "done", messages: historyRef.current } });
      }
    },
    [state.busy, llm, tools, vision, exit],
  );

  useInput((_ch: string, key: Key) => {
    if (key.ctrl && _ch === "c") { abortRef.current.abort(); exit(); }
  });

  return (
    <Box flexDirection="column">
      {/* Slim top bar */}
      <Box paddingX={1} gap={2}>
        <Text color="cyan" bold>mini-agent</Text>
        <Text dimColor>{state.modelName}</Text>
        {state.busy
          ? <Box gap={1}><Text color="yellow"><Spinner type="dots" /></Text><Text dimColor>{state.status}</Text></Box>
          : <Text dimColor>{state.status}</Text>
        }
        <Text dimColor>[/clear] [Ctrl+C]</Text>
      </Box>

      <Text dimColor>{"─".repeat(60)}</Text>

      {/* Scrollable message feed */}
      <MessageFeed
        messages={state.messages}
        streamingText={state.streamingText}
      />

      <Text dimColor>{"─".repeat(60)}</Text>

      {/* Fixed input row */}
      <Box paddingX={1} gap={1}>
        <Text color="green" bold>{state.busy ? "…" : ">"}</Text>
        {state.busy
          ? <Text dimColor>等待模型响应...</Text>
          : (
            <TextInput
              value={input}
              onChange={setInput}
              onSubmit={(val) => { void handleSubmit(val); }}
              placeholder="输入消息 (Enter 发送)"
            />
          )
        }
      </Box>
    </Box>
  );
}
