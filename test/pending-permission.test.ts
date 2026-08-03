import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolvePendingPermissionDecision } from "../src/tui/pending-permission.ts";
import type { Key } from "ink";

describe("pending permission input", () => {
  it("treats Enter as deny and A/D as explicit choices", () => {
    assert.equal(resolvePendingPermissionDecision("", { escape: true } as Key), "deny");
    assert.equal(resolvePendingPermissionDecision("", { return: true } as Key), "deny");
    assert.equal(resolvePendingPermissionDecision("a", { return: false } as Key), "allow");
    assert.equal(resolvePendingPermissionDecision("A", { return: false } as Key), "allow");
    assert.equal(resolvePendingPermissionDecision("d", { return: false } as Key), "deny");
    assert.equal(resolvePendingPermissionDecision("D", { return: false } as Key), "deny");
    assert.equal(resolvePendingPermissionDecision("x", { return: false } as Key), null);
  });
});
