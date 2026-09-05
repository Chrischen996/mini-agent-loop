/**
 * Shared plumbing for the HTTP route modules split out of `src/server.ts`.
 *
 * Each route module receives a narrow context object describing only the
 * collaborators it needs, so a domain can be read, tested, and changed without
 * loading the whole server factory.
 */

import type { Response } from "express";

/** Narrow the unknown thrown value to a message string. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs `handler` and converts any thrown error into a JSON error response.
 * Mirrors the ad-hoc `try/catch` blocks the routes previously repeated.
 */
export async function respondOrFail(
  response: Response,
  status: number,
  handler: () => Promise<void> | void,
): Promise<void> {
  try {
    await handler();
  } catch (error) {
    response.status(status).json({ error: errorMessage(error) });
  }
}
