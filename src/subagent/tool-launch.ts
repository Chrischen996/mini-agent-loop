// Launch-time resource gates for the sub-agent tool.
//
// Split out of `subagent/tool.ts`: `execute` inlined a self-contained global
// token/call budget gate that rejected the launch when the shared budget was
// exhausted. It lives here so the tool's `execute` no longer carries it.

import type { GlobalBudgetState } from "../loop.ts";
import type { SubagentArgs } from "./types.ts";

type ToolResultLike = { content: string; isError?: boolean };

/**
 * Read the shared global budget ledger and reject the launch when the token
 * or call budget is exhausted. Mutates `budget` in place (token/call counters
 * are refreshed from their ledgers) so the caller reuses the same object as
 * the child's `globalBudgetState` runtime ref.
 */
export async function checkLaunchBudgets(
  budget: GlobalBudgetState | undefined,
  args: SubagentArgs,
): Promise<ToolResultLike | undefined> {
  if (budget?.tokenLedger) {
    budget.used = await budget.tokenLedger.readTokens();
  }
  if (budget?.callLedger) {
    budget.callsUsed = await budget.callLedger.readCalls();
  }
  if (budget?.limit !== undefined && budget.used >= budget.limit) {
    return {
      content: `Sub-agent global token budget exhausted (${budget.limit}).`,
      isError: true,
    };
  }
  // Call budget (Grok Build-style agent_budget): reject the launch when
  // the shared invocation cap is exhausted, otherwise count this launch.
  if (budget?.callsLimit !== undefined && !args._callBudgetReserved) {
    const callsUsed = budget.callsUsed ?? 0;
    const reservedCalls = budget.callLedger
      ? await budget.callLedger.reserveCalls(1, budget.callsLimit)
      : callsUsed < budget.callsLimit ? callsUsed + 1 : undefined;
    if (reservedCalls === undefined) {
      return {
        content: `Sub-agent call budget exhausted (${callsUsed}/${budget.callsLimit}). No further sub-agents will be launched.`,
        isError: true,
      };
    }
    budget.callsUsed = reservedCalls;
  }
  return undefined;
}
