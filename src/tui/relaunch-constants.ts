/**
 * Shared constants for the dual-process (supervisor + child) architecture.
 *
 * Kept in its own module so that the heavy child entry (ink-main.tsx) can
 * import just the exit-code constant without pulling in the full supervisor
 * spawn logic (child_process, os, signal forwarding, etc.).
 */

/** Exit code the child uses to request a relaunch. */
export const RELAUNCH_EXIT_CODE = 47;
