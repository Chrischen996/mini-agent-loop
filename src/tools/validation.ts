import { formatValidationReport, runValidation, type ValidationStepName } from "../validation.ts";
import type { Tool } from "./types.ts";

export function createValidationTool(cwd: string): Tool {
  return {
    name: "validate_workspace",
    description: "Run the workspace test, typecheck, and build scripts in order and return a bounded validation report.",
    source: { kind: "local" },
    annotations: { readOnlyHint: true, idempotentHint: true },
    parameters: {
      type: "object",
      properties: {
        steps: { type: "array", items: { type: "string", enum: ["test", "typecheck", "build"] } },
        timeoutMs: { type: "integer", minimum: 1000, maximum: 600000 },
      },
      additionalProperties: false,
    },
    execute: async (args, signal) => {
      const input = args as { steps?: unknown; timeoutMs?: unknown };
      const steps = Array.isArray(input.steps)
        ? input.steps.filter((value): value is ValidationStepName => value === "test" || value === "typecheck" || value === "build")
        : undefined;
      const report = await runValidation({
        workspace: cwd,
        steps,
        timeoutMs: typeof input.timeoutMs === "number" ? input.timeoutMs : undefined,
        signal,
      });
      return { content: formatValidationReport(report), isError: !report.ok };
    },
  };
}
