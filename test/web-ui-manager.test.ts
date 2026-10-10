import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WebUiManager } from "../src/tui/web-ui-manager.ts";

/**
 * State-machine tests that do NOT spawn processes (doc §11.1). The real
 * start()/stop() lifecycle is exercised by the manual smoke script instead,
 * because spawning a server in the unit-test suite would leak port 3001.
 */
describe("web ui manager state machine (P1 review fix)", () => {
  it("starts in the stopped state with the default workbench port", () => {
    const manager = new WebUiManager();
    const st = manager.status();
    assert.equal(st.status, "stopped");
    assert.equal(st.port, 3001);
    assert.equal(st.url, undefined);
  });

  it("stop() on a stopped manager is a no-op success", async () => {
    const manager = new WebUiManager();
    const res = await manager.stop();
    assert.equal(res.ok, true);
    assert.equal(res.message, "Already stopped.");
    assert.equal(manager.status().status, "stopped");
  });

  it("custom constructor port is reflected in state and url", () => {
    const manager = new WebUiManager(3080);
    const st = manager.status();
    assert.equal(st.port, 3080);
    // url is only exposed while running
    assert.equal(st.url, undefined);
  });
});
