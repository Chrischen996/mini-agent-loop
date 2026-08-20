import type { MessageContent } from "../types.ts";
import type { PermissionTurnContext } from "../permissions.ts";
import type { ToolProvider } from "../tools/types.ts";
import { parseAtRefs } from "./input-utils.ts";
import { resolveToolProvider } from "../tools/types.ts";
import { PermissionModeChangedError } from "../permissions.ts";

/**
 * Resolve @file references in user input by reading file contents through tools.
 */
export async function resolveAtRefs(
  text: string,
  permissionTurn: PermissionTurnContext,
  allTools: ToolProvider,
): Promise<MessageContent> {
  const paths = parseAtRefs(text);
  if (paths.length === 0) return text;

  const readTool = resolveToolProvider(allTools).find((t) => t.name === "read");
  if (!readTool) return text;

  const parts: MessageContent = [{ type: "text", text }];
  for (const p of paths) {
    try {
      const result = await permissionTurn.execute(readTool, { path: p });
      const content = typeof result.content === "string" ? result.content : "";
      parts.push({ type: "text", text: `\n\n[File: ${p}]\n\`\`\`\n${content}\n\`\`\`` });
    } catch (error) {
      if (error instanceof PermissionModeChangedError || permissionTurn.signal.aborted) throw error;
      // Keep unresolved references out of the model prompt
    }
  }
  return parts;
}
