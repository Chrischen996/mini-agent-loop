import assert from "node:assert/strict";
import { it } from "node:test";
import { workspacePanelScope } from "../apps/web/src/lib/workspace-scope.ts";

it("browses the selected workspace when it differs from the active session", () => {
  assert.deepEqual(
    workspacePanelScope("session-a", "workspace-a", "workspace-b"),
    { workspaceId: "workspace-b" },
  );
  assert.deepEqual(
    workspacePanelScope("session-a", "workspace-a", "workspace-a"),
    { sessionId: "session-a" },
  );
  assert.deepEqual(
    workspacePanelScope(null, undefined, "workspace-b"),
    { workspaceId: "workspace-b" },
  );
});
