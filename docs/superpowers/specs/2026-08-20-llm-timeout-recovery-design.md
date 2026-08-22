# LLM Timeout Recovery Design

**Status:** Approved by the task request

## Goal

Make LLM timeouts recoverable without replaying side effects, while preserving partial output for both the main agent and nested sub-agents.

## Architecture

The request layer will distinguish the first-response deadline, stream-idle deadline, and total request deadline. The existing `MINI_AGENT_REQUEST_TIMEOUT_MS` remains the total timeout; an idle timer resets whenever a stream chunk arrives, including reasoning deltas. Timeout errors carry a typed phase and elapsed timeout metadata.

The agent loop will retry a timeout once only when the current generation produced no answer text and no assistant tool call was completed. A timed-out stream with answer text remains terminal for that turn and preserves the partial assistant message. The UI reports the timeout phase and preview without displaying an empty placeholder.

Nested sub-agents remain isolated from parent execution. On timeout they return an error result containing the best recovered transcript text, timeout phase, and a partial marker when available. The parent can then decide whether to retry or change the task; the timeout does not abort the parent loop.

## Timeout Policy

- Total request timeout: existing `MINI_AGENT_REQUEST_TIMEOUT_MS`, default 120 seconds.
- First-response timeout: configurable separately, defaulting to the total request timeout to preserve current behavior.
- Stream idle timeout: configurable with `MINI_AGENT_STREAM_IDLE_TIMEOUT_MS`, default 60 seconds.
- A timeout before any answer text may be retried once immediately and emits `retry_attempt`.
- A timeout after answer text is received is not automatically replayed; the partial assistant message is saved.
- Tool side effects are never replayed by timeout handling. Tool execution only begins after a complete assistant response.

## Data Flow

1. The request timer creates a shared abort signal and records which deadline fired.
2. The streaming parser marks the response as started and refreshes the idle deadline for every received chunk.
3. The loop receives a typed `LlmTimeoutError`.
4. If the response is retry-safe, the loop emits `retry_attempt`, clears transient stream state, and retries once.
5. Otherwise, the loop appends streamed answer text to history and rethrows the error with the recovered messages.
6. The main UI renders a phase-specific error; a nested sub-agent converts the recovered messages into a partial tool result.

## Testing

- Request timers identify first-response, idle, and total timeout phases.
- Stream activity prevents an idle timeout while the total deadline still stops an overlong request.
- A no-output timeout retries once and then fails with the typed error.
- A partial-output timeout does not retry and preserves the assistant message.
- A sub-agent timeout returns recovered partial text and `isError: true` without aborting the parent.
- Existing timeout, retry, stream, loop, and sub-agent tests remain green.
