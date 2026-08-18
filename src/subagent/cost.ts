import { resolveModel } from "../models.ts";
import type { LlmConfig } from "../llm/index.ts";
import type { SubagentCost, SubagentTokenBreakdown } from "./types.ts";

/**
 * Estimate monetary cost (in USD) for a subagent token breakdown based on model pricing.
 */
export function calculateSubagentCost(
  llm: LlmConfig,
  breakdown: SubagentTokenBreakdown,
): SubagentCost | undefined {
  try {
    const modelRef = resolveModel(llm.model, llm.baseUrl);
    const costRates = modelRef.cost ?? modelRef.piModel?.cost;

    if (!costRates) {
      return undefined;
    }

    const inputTokens = breakdown.inputTokens || (breakdown.promptTokens - (breakdown.cacheReadTokens ?? 0) - (breakdown.cacheWriteTokens ?? 0));
    const uncachedInput = Math.max(0, inputTokens);
    const outputTokens = Math.max(0, breakdown.completionTokens);
    const cacheReadTokens = Math.max(0, breakdown.cacheReadTokens ?? 0);
    const cacheWriteTokens = Math.max(0, breakdown.cacheWriteTokens ?? 0);

    const inputCost = (costRates.input / 1_000_000) * uncachedInput;
    const outputCost = (costRates.output / 1_000_000) * outputTokens;
    const cacheReadCost = ((costRates.cacheRead ?? costRates.input) / 1_000_000) * cacheReadTokens;
    const cacheWriteCost = ((costRates.cacheWrite ?? costRates.input) / 1_000_000) * cacheWriteTokens;
    const totalCost = inputCost + outputCost + cacheReadCost + cacheWriteCost;

    return {
      input: Number(inputCost.toFixed(6)),
      output: Number(outputCost.toFixed(6)),
      cacheRead: Number(cacheReadCost.toFixed(6)),
      cacheWrite: Number(cacheWriteCost.toFixed(6)),
      total: Number(totalCost.toFixed(6)),
    };
  } catch {
    return undefined;
  }
}
