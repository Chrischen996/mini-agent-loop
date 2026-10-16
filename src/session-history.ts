import type { AgentMessage, ToolResultMessage } from "./types.ts";

/**
 * Return the part of a transcript that can safely be sent to a chat API.
 *
 * A provider requires every assistant tool-call message to be followed by one
 * result for each declared call. Interrupted turns can leave a partial block,
 * an orphan result, or an empty assistant message on disk. Keep the durable
 * snapshot unchanged, but remove those records from the in-memory resume view.
 */
export function sanitizeResumableMessages(
  messages: readonly AgentMessage[],
  visibleCount = Number.POSITIVE_INFINITY,
): AgentMessage[] {
  const systemMessages = messages.filter((message) => message.role === "system");
  const visibleMessages = messages
    .filter((message) => message.role !== "system")
    .slice(0, Math.max(0, visibleCount));
  const result: AgentMessage[] = [];
  let discardUntilUser = false;

  for (let index = 0; index < visibleMessages.length; index += 1) {
    const message = visibleMessages[index]!;

    if (discardUntilUser) {
      if (message.role !== "user") continue;
      discardUntilUser = false;
    }

    if (message.role === "tool") {
      // Tool results are valid only inside the contiguous block handled below.
      continue;
    }

    if (message.role === "user") {
      result.push(message);
      continue;
    }

    const calls = message.toolCalls ?? [];
    if (calls.length === 0) {
      if (message.content.trim().length > 0) result.push(message);
      continue;
    }

    const expectedIds = new Set(calls.map((call) => call.id));
    const toolResults: ToolResultMessage[] = [];
    const foundIds = new Set<string>();
    let nextIndex = index + 1;
    while (nextIndex < visibleMessages.length && visibleMessages[nextIndex]?.role === "tool") {
      const toolResult = visibleMessages[nextIndex]!;
      if (toolResult.role !== "tool") break;
      toolResults.push(toolResult);
      foundIds.add(toolResult.toolCallId);
      nextIndex += 1;
    }

    const complete =
      calls.length === expectedIds.size &&
      toolResults.length === expectedIds.size &&
      foundIds.size === expectedIds.size &&
      toolResults.every((toolResult) => expectedIds.has(toolResult.toolCallId));

    if (!complete) {
      // If tool results were incomplete (e.g. process crashed or was interrupted
      // before result could be written), synthesize unknown results for missing tool calls
      // so we do not discard already completed side-effects, while warning that status is unknown.
      const repairedToolResults: ToolResultMessage[] = [...toolResults];
      for (const call of calls) {
        if (!foundIds.has(call.id)) {
          repairedToolResults.push({
            role: "tool",
            toolCallId: call.id,
            name: call.name,
            content: `[未知结果 / 进程中断] 工具 ${call.name} 已派发执行，但在结果写入前进程中断或异常退出。请检查实际状态，请勿直接重放。`,
            isError: true,
          });
        }
      }
      result.push(message, ...repairedToolResults);
      index = nextIndex - 1;
      continue;
    }

    result.push(message, ...toolResults);
    index = nextIndex - 1;
  }

  return [...systemMessages, ...result];
}
