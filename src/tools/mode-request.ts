import type { Tool, ToolResult } from "./types.ts";

export const MODE_REQUEST_TOOL_NAME = "request_permission_mode";

export type RequestPermissionModeArgs = {
  mode: "plan" | "bypass";
  reason: string;
};

/**
 * Model-initiated permission-mode escalation request.
 *
 * The tool deliberately does NOT touch the `PermissionManager`. It only records
 * the intent on the tool result, and the client turns that into a one-key
 * confirmation card. Keeping the switch out of the tool is what preserves plan
 * mode as a human decision: a poisoned file or MCP payload that reaches the
 * model can at most ask, never grant itself write/exec authority.
 */
export function createRequestPermissionModeTool(): Tool<RequestPermissionModeArgs> {
  const tool: Tool<RequestPermissionModeArgs> = {
    name: MODE_REQUEST_TOOL_NAME,
    displayName: "RequestMode",
    description:
      "Ask the user to switch the session permission mode (for example plan to bypass) when the task needs writes or shell execution. "
      + "This only opens a confirmation prompt; the user must approve it and the current turn is not retried automatically. "
      + "Do not call it again while a request is already pending.",
    source: { kind: "local" },
    annotations: {
      title: "Request a permission mode change",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
    },
    capabilities: {
      readWorkspace: false,
      writeWorkspace: false,
      executeProcess: false,
      network: false,
      externalData: false,
      destructive: false,
      requiresApproval: false,
    },
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        mode: {
          type: "string",
          enum: ["plan", "bypass"],
          description: "Mode to request. 'bypass' allows writes and shell execution without further approval.",
        },
        reason: {
          type: "string",
          minLength: 1,
          maxLength: 400,
          description: "One or two sentences telling the user why this mode is needed right now.",
        },
      },
      required: ["mode", "reason"],
    },
    async execute(args): Promise<ToolResult> {
      const mode = args?.mode;
      const reason = typeof args?.reason === "string" ? args.reason.trim() : "";
      if (mode !== "plan" && mode !== "bypass") {
        return { content: "mode must be 'plan' or 'bypass'", isError: true };
      }
      if (!reason) {
        return { content: "reason is required so the user can decide", isError: true };
      }
      return {
        content: [
          `Recorded a request to switch to ${mode} mode.`,
          "The user must confirm it in the permission card; the mode does not change on its own.",
          `If the session is already in ${mode} mode this is a no-op and no card appears.`,
          "Do not call tools that need the new mode in this turn. Wait for the next turn.",
        ].join(" "),
        modeRequest: { mode, reason },
      };
    },
  };
  return tool;
}
