import type { AgentMessage, ToolResultMessage } from "./types.ts";

/**
 * Return the part of a transcript that can safely be sent to a chat API.
 *
 * A provider requires every assistant tool-call message to be followed by one
 * result for each declared call. Interrupted turns can leave a partial block,
 * an orphan result, or an empty assistant message on disk. Keep the durable
 * snapshot unchanged, but remove those records from the in-memory resume view.
 *
 * Two different repairs are applied, because the two situations are not the
 * same:
 *
 * - The result is *missing from the record* (the process died mid-turn). The
 *   call may already have had side effects, so the block is kept and a
 *   synthetic unknown result is added to keep the provider contract valid.
 * - The result *exists in the transcript* but was cut off by `visibleCount`
 *   (a deliberate rewind to an earlier message). Nothing went wrong, so the
 *   incomplete block is dropped as a unit instead of being rewritten with a
 *   result the model never produced.
 */
export function sanitizeResumableMessages(
  messages: readonly AgentMessage[],
  visibleCount = Number.POSITIVE_INFINITY,
): AgentMessage[] {
  const systemMessages = messages.filter((message) => message.role === "system");
  const nonSystemMessages = messages.filter((message) => message.role !== "system");
  const visibleMessages = nonSystemMessages.slice(0, Math.max(0, visibleCount));
  /** Tool call ids that have a result somewhere in the durable record. */
  const recordedToolResultIds = new Set(
    nonSystemMessages
      .filter((message): message is ToolResultMessage => message.role === "tool")
      .map((message) => message.toolCallId),
  );
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
      const missingIds = calls.filter((call) => !foundIds.has(call.id)).map((call) => call.id);
      const cutByBoundary = missingIds.some((id) => recordedToolResultIds.has(id));
      if (cutByBoundary) {
        // The transcript holds these results; the visible window just ends
        // before them. Drop the whole block rather than inventing a result.
        index = nextIndex - 1;
        continue;
      }
      // The result was never written (e.g. process crashed or was interrupted
      // before it could be persisted). The call may already have had side
      // effects, so synthesize an unknown result for the missing calls to
      // keep the provider contract valid instead of discarding them.
      const repairedToolResults: ToolResultMessage[] = [...toolResults];
      for (const call of calls) {
        if (!foundIds.has(call.id)) {
          repairedToolResults.push({
            role: "tool",
            toolCallId: call.id,
            name: call.name,
            content: `[unknown result / interrupted] Tool ${call.name} was dispatched, but the process ended before its result was written. Check the real state before re-running it.`,
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
