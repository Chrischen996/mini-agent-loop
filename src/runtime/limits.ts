function readNonNegativeInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

export function loadGlobalTokenBudgetFromEnv(): number | undefined {
  return readNonNegativeInt(process.env.MINI_AGENT_GLOBAL_TOKEN_BUDGET);
}

export function loadGlobalConcurrencyLimitFromEnv(): number | undefined {
  const value = readNonNegativeInt(process.env.MINI_AGENT_GLOBAL_CONCURRENCY_LIMIT);
  return value === 0 ? undefined : value;
}
