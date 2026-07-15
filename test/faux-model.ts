import type { ChatFn } from "../src/llm.ts";
import type { AgentMessage, AssistantMessage } from "../src/types.ts";
import type { Tool } from "../src/tools/types.ts";

/**
 * Scripted ChatFn for offline loop tests:
 * 1) First call: assistant with one `read` tool call for package.json
 * 2) Second call: final assistant text summarizing content
 * 3) Extra calls fail the test
 */
export function createFauxChat(options?: {
  readPath?: string;
  finalText?: string;
  toolCallId?: string;
}): ChatFn {
  const readPath = options?.readPath ?? "package.json";
  const finalText =
    options?.finalText ??
    `Project name from ${readPath}: mini-agent (faux summary)`;
  const toolCallId = options?.toolCallId ?? "call_read_1";

  let callCount = 0;

  const fauxChat: ChatFn = async (
    _config,
    messages: AgentMessage[],
    _tools?: Tool[],
  ): Promise<AssistantMessage> => {
    callCount += 1;

    if (callCount === 1) {
      return {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: toolCallId,
            name: "read",
            arguments: { path: readPath },
          },
        ],
      };
    }

    if (callCount === 2) {
      // Sanity: previous messages should include a tool result for our call id.
      const hasToolResult = messages.some(
        (m) => m.role === "tool" && m.toolCallId === toolCallId,
      );
      if (!hasToolResult) {
        throw new Error(
          "faux model expected a tool result before the second LLM call",
        );
      }
      return {
        role: "assistant",
        content: finalText,
      };
    }

    throw new Error(
      `faux model received unexpected extra LLM call (#${callCount})`,
    );
  };

  return fauxChat;
}

/** Scripted chat that always requests an unknown tool (for error-path tests). */
export function createUnknownToolFauxChat(
  toolCallId = "call_unknown_1",
): ChatFn {
  let callCount = 0;
  return async (): Promise<AssistantMessage> => {
    callCount += 1;
    if (callCount === 1) {
      return {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: toolCallId,
            name: "not_a_real_tool",
            arguments: {},
          },
        ],
      };
    }
    if (callCount === 2) {
      return {
        role: "assistant",
        content: "Acknowledged unknown tool error.",
      };
    }
    throw new Error(`unexpected faux call #${callCount}`);
  };
}

/** Always returns a tool call so maxTurns can be exercised. */
export function createInfiniteToolFauxChat(): ChatFn {
  let n = 0;
  return async (): Promise<AssistantMessage> => {
    n += 1;
    return {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: `call_loop_${n}`,
          name: "read",
          arguments: { path: "package.json" },
        },
      ],
    };
  };
}
