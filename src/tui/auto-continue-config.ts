/**
 * Auto-continue configuration for handling max_tokens truncation.
 * 
 * When enabled, the TUI will automatically retry with /continue when
 * LLM output is truncated due to max_tokens limit.
 */

export type AutoContinueConfig = {
  /** Enable auto-continue feature */
  enabled: boolean;
  /** Maximum number of auto-continue attempts (0 = unlimited) */
  maxAttempts: number;
  /** Delay in milliseconds before triggering auto-continue */
  delayMs: number;
};

/**
 * Load auto-continue configuration from environment variables.
 */
export function loadAutoContinueConfig(env: NodeJS.ProcessEnv = process.env): AutoContinueConfig {
  const enabled = env.MINI_AGENT_AUTO_CONTINUE_ON_TRUNCATE?.toLowerCase() !== "false";
  const maxAttempts = parseInt(env.MINI_AGENT_MAX_AUTO_CONTINUES ?? "3", 10);
  const delayMs = parseInt(env.MINI_AGENT_AUTO_CONTINUE_DELAY_MS ?? "500", 10);

  return {
    enabled: enabled && !isNaN(maxAttempts) && maxAttempts >= 0,
    maxAttempts: isNaN(maxAttempts) ? 3 : Math.max(0, maxAttempts),
    delayMs: isNaN(delayMs) ? 500 : Math.max(100, delayMs),
  };
}

/**
 * Check if auto-continue should be triggered for this error.
 */
export function shouldAutoContinue(
  error: Error | { name?: string; message?: string },
  config: AutoContinueConfig,
  attemptCount: number,
): boolean {
  if (!config.enabled) return false;
  if (config.maxAttempts > 0 && attemptCount >= config.maxAttempts) return false;

  // Check for OutputTruncatedError or max_tokens related errors
  const errorName = error?.name ?? "";
  const errorMessage = error?.message ?? String(error);
  
  return (
    errorName === "OutputTruncatedError" ||
    /max_tokens|output reached|finish_reason.*length/i.test(errorMessage)
  );
}
