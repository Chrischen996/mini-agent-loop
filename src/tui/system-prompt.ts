import path from "node:path";
import { loadInstructionBundle } from "../agents-md.ts";
import { getDataRoot } from "../session-store.ts";
import { MemoryStore } from "../orchestration/memory-store.ts";
import { isAutoMemoryEnabled } from "../memory/auto-memory.ts";
import { buildSystemPrompt, createAgentHistory } from "../loop.ts";
import type { PermissionMode } from "../permissions.ts";

export type TuiSystemPromptContext = {
  agentsMd?: string;
  memorySection?: string;
};

export async function loadTuiSystemPromptContext(cwd: string): Promise<TuiSystemPromptContext> {
  const agentsMd = (await loadInstructionBundle(cwd)).content || undefined;
  const memoryStore = new MemoryStore(path.join(getDataRoot(), "memory", "records.json"));
  const memorySection = isAutoMemoryEnabled()
    ? await memoryStore.buildSystemMemoryPrompt().catch(() => undefined)
    : undefined;
  return { agentsMd, memorySection };
}

export function buildTuiSystemPrompt(
  permissionMode: PermissionMode,
  context: TuiSystemPromptContext = {},
): string {
  return buildSystemPrompt(permissionMode, context.agentsMd, context.memorySection);
}

export function createTuiAgentHistory(
  permissionMode: PermissionMode,
  context: TuiSystemPromptContext = {},
): ReturnType<typeof createAgentHistory> {
  return createAgentHistory(buildTuiSystemPrompt(permissionMode, context), permissionMode);
}
