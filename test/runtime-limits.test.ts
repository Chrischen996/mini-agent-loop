import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { withEnv } from "./helpers/env-snapshot.ts";
import {
  loadGlobalConcurrencyLimitFromEnv,
  loadGlobalTokenBudgetFromEnv,
} from "../src/runtime/limits.ts";

describe("runtime resource limits", () => {
  it("returns undefined when limits are not configured", async () => {
    await withEnv({
      MINI_AGENT_GLOBAL_TOKEN_BUDGET: undefined,
      MINI_AGENT_GLOBAL_CONCURRENCY_LIMIT: undefined,
    }, () => {
      assert.equal(loadGlobalTokenBudgetFromEnv(), undefined);
      assert.equal(loadGlobalConcurrencyLimitFromEnv(), undefined);
    });
  });

  it("loads non-negative integer budgets and concurrency limits", async () => {
    await withEnv({
      MINI_AGENT_GLOBAL_TOKEN_BUDGET: "12000",
      MINI_AGENT_GLOBAL_CONCURRENCY_LIMIT: "3",
    }, () => {
      assert.equal(loadGlobalTokenBudgetFromEnv(), 12000);
      assert.equal(loadGlobalConcurrencyLimitFromEnv(), 3);
    });
  });

  it("treats zero concurrency as unlimited", async () => {
    await withEnv({
      MINI_AGENT_GLOBAL_TOKEN_BUDGET: "0",
      MINI_AGENT_GLOBAL_CONCURRENCY_LIMIT: "0",
    }, () => {
      assert.equal(loadGlobalTokenBudgetFromEnv(), 0);
      assert.equal(loadGlobalConcurrencyLimitFromEnv(), undefined);
    });
  });

  it("ignores malformed and negative values", async () => {
    await withEnv({
      MINI_AGENT_GLOBAL_TOKEN_BUDGET: "-1",
      MINI_AGENT_GLOBAL_CONCURRENCY_LIMIT: "2.5",
    }, () => {
      assert.equal(loadGlobalTokenBudgetFromEnv(), undefined);
      assert.equal(loadGlobalConcurrencyLimitFromEnv(), undefined);
    });
  });
});
