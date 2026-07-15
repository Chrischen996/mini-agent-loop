import type { Tool } from "./tools/types.ts";

/**
 * Parse a raw tool-arguments JSON string into a plain object.
 * Throws if the payload is not a JSON object.
 */
export function parseToolArgumentsJson(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid tool arguments JSON: ${message}`);
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Tool arguments must be a JSON object");
  }

  return parsed as Record<string, unknown>;
}

/**
 * Naive schema validation for teaching:
 * - required keys must exist
 * - basic typeof checks for string / number / integer / boolean
 * - rejects unknown keys when additionalProperties === false
 */
export function validateToolArgs(
  tool: Tool,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const schema = tool.parameters ?? {};
  const properties =
    (schema.properties as Record<string, Record<string, unknown>> | undefined) ??
    {};
  const required = (schema.required as string[] | undefined) ?? [];
  const additionalProperties = schema.additionalProperties;

  for (const key of required) {
    if (args[key] === undefined) {
      throw new Error(`Missing required argument: ${key}`);
    }
  }

  if (additionalProperties === false) {
    for (const key of Object.keys(args)) {
      if (!(key in properties)) {
        throw new Error(`Unexpected argument: ${key}`);
      }
    }
  }

  for (const [key, value] of Object.entries(args)) {
    const prop = properties[key];
    if (!prop) continue;

    const expectedType = prop.type as string | undefined;
    if (!expectedType || value === undefined) continue;

    switch (expectedType) {
      case "string":
        if (typeof value !== "string") {
          throw new Error(`Argument "${key}" must be a string`);
        }
        break;
      case "number":
        if (typeof value !== "number" || Number.isNaN(value)) {
          throw new Error(`Argument "${key}" must be a number`);
        }
        break;
      case "integer":
        if (typeof value !== "number" || !Number.isInteger(value)) {
          throw new Error(`Argument "${key}" must be an integer`);
        }
        if (typeof prop.minimum === "number" && value < prop.minimum) {
          throw new Error(
            `Argument "${key}" must be >= ${prop.minimum as number}`,
          );
        }
        break;
      case "boolean":
        if (typeof value !== "boolean") {
          throw new Error(`Argument "${key}" must be a boolean`);
        }
        break;
      default:
        break;
    }
  }

  return args;
}
