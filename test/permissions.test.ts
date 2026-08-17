import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PermissionManager,
  PermissionModeChangedError,
  type PermissionMode,
} from "../src/permissions.ts";
import type { Tool } from "../src/tools/types.ts";

const writeTool: Tool = {
  name: "write",
  description: "write",
  parameters: { type: "object" },
  execute: async () => ({ content: "ok" }),
};

describe("PermissionManager", () => {
  it("defaults to plan mode and hard-denies writes without interactive approval", async () => {
    const manager = new PermissionManager();
    assert.equal(manager.getMode(), "plan");
    const events: Array<{ type: string; id: string }> = [];
    manager.onPermissionEvent = (event) => {
      events.push({ type: event.type, id: event.request.id });
    };
    await assert.rejects(
      manager.authorize("session", writeTool, { path: "a.txt" }, undefined, () => {
        throw new Error("plan mode must not open interactive approval");
      }),
      /Permission denied.*plan mode/,
    );
    assert.equal(events.length, 2);
    assert.equal(events[0]?.type, "request");
    assert.equal(events[1]?.type, "deny");
    // No pending request can be resolved into execution.
    assert.equal(manager.resolve("session", events[0]!.id, "allow"), false);
  });

  it("automatically allows read-only tools in plan mode", async () => {
    const manager = new PermissionManager();
    const readTool = { ...writeTool, name: "read" };
    await manager.authorize("session", readTool, {}, undefined, () => {
      throw new Error("read should not request permission");
    });
  });

  it("automatically allows read-only codebase operations after opening a handle", async () => {
    const manager = new PermissionManager();
    for (const name of ["codebase_search", "codebase_read", "codebase_explain"]) {
      await manager.authorize("session", { ...writeTool, name }, {}, undefined, () => {
        throw new Error(`${name} should not request permission`);
      });
    }
  });

  it("treats pi-web-access reads as read-only open-world tools", async () => {
    const webTool: Tool = {
      ...writeTool,
      name: "web_search",
      source: { kind: "web", package: "pi-web-access" },
      annotations: { readOnlyHint: true, openWorldHint: true },
    };
    await new PermissionManager("plan").authorize("session", webTool, { query: "test" }, undefined, () => {
      throw new Error("plan web search should not request approval");
    });
    await new PermissionManager("bypass").authorize("session", webTool, { query: "test" }, undefined, () => {
      throw new Error("bypass web search should not request approval");
    });
  });

  it("allows codebase_open in plan mode as a local read-oriented tool", async () => {
    const manager = new PermissionManager("plan");
    await manager.authorize(
      "session",
      { ...writeTool, name: "codebase_open" },
      { repository: "octo/project" },
      undefined,
      () => {
        throw new Error("codebase_open should not request permission in plan mode");
      },
    );
  });

  it("never auto-allows an MCP tool based on its name or annotations", async () => {
    const manager = new PermissionManager("plan");
    const remoteRead: Tool = {
      ...writeTool,
      name: "read",
      source: { kind: "mcp", serverId: "remote", toolName: "read" },
      annotations: { readOnlyHint: true },
    };
    const events: Array<{ type: string; risk: string }> = [];
    manager.onPermissionEvent = (event) => {
      events.push({ type: event.type, risk: event.request.risk });
    };
    await assert.rejects(
      manager.authorize("session", remoteRead, {}, undefined, () => {
        throw new Error("plan mode must not open interactive approval");
      }),
      /Permission denied.*plan mode/,
    );
    assert.equal(events[0]?.type, "request");
    assert.equal(events[0]?.risk, "high");
    assert.equal(events[1]?.type, "deny");
  });

  it("bypass mode allows MCP tools through the shared policy", async () => {
    const manager = new PermissionManager("bypass");
    const remoteWrite: Tool = {
      ...writeTool,
      source: { kind: "mcp", serverId: "remote", toolName: "write" },
    };
    await manager.authorize("session", remoteWrite, {}, undefined, () => {
      throw new Error("bypass mode must not request MCP approval");
    });
  });

  describe("Permission Modes", () => {
    it("plan mode: hard-denies write tools, allows read-only bash, and hard-denies dangerous bash", async () => {
      const manager = new PermissionManager("plan");
      const writeToolMock = { ...writeTool, name: "write" };
      const bashToolMock = { ...writeTool, name: "bash" };
      const readToolMock = { ...writeTool, name: "read" };

      // Write is analysis-only: hard-deny without opening an approval prompt
      const writeEvents: Array<{ type: string; id: string }> = [];
      manager.onPermissionEvent = (event) => {
        writeEvents.push({ type: event.type, id: event.request.id });
      };
      await assert.rejects(
        manager.authorize("session", writeToolMock, { path: "test.txt", content: "hello" }, undefined, () => {
          throw new Error("plan mode must not open interactive approval");
        }),
        /Permission denied.*plan mode/,
      );
      assert.equal(writeEvents.length, 2);
      assert.equal(writeEvents[0]?.type, "request");
      assert.equal(writeEvents[1]?.type, "deny");
      assert.equal(manager.resolve("session", writeEvents[0]!.id, "allow"), false);

      // Read-only bash should auto-allow in plan mode
      await manager.authorize("session", bashToolMock, { command: "find . -type f | head -50" }, undefined, () => {
        throw new Error("read-only bash should auto-allow in plan mode");
      });

      // Read-only bash should not be blocked by dangerous-looking search terms
      await manager.authorize("session", bashToolMock, { command: "grep rm README.md" }, undefined, () => {
        throw new Error("grep with a dangerous-looking search term should still auto-allow in plan mode");
      });

      // Dangerous bash is hard-denied in plan mode
      const bashEvents: Array<{ type: string; risk: string }> = [];
      manager.onPermissionEvent = (event) => {
        bashEvents.push({ type: event.type, risk: event.request.risk });
      };
      await assert.rejects(
        manager.authorize("session", bashToolMock, { command: "rm -rf /" }, undefined, () => {
          throw new Error("plan mode must not open interactive approval");
        }),
        /Permission denied.*plan mode/,
      );
      assert.equal(bashEvents[0]?.type, "request");
      assert.equal(bashEvents[0]?.risk, "high");
      assert.equal(bashEvents[1]?.type, "deny");

      // Shell wrappers should still catch dangerous inner commands
      const wrappedEvents: Array<{ type: string; risk: string }> = [];
      manager.onPermissionEvent = (event) => {
        wrappedEvents.push({ type: event.type, risk: event.request.risk });
      };
      await assert.rejects(
        manager.authorize("session", bashToolMock, { command: "bash -c 'rm -rf /'" }, undefined, () => {
          throw new Error("plan mode must not open interactive approval");
        }),
        /Permission denied.*plan mode/,
      );
      assert.equal(wrappedEvents[0]?.type, "request");
      assert.equal(wrappedEvents[0]?.risk, "high");
      assert.equal(wrappedEvents[1]?.type, "deny");

      // Read should auto-allow
      await manager.authorize("session", readToolMock, { path: "test.txt" }, undefined, () => {
        throw new Error("read should auto-allow in plan mode");
      });
    });

    it("bypass mode: auto-allows everything including write and bash", async () => {
      const manager = new PermissionManager("bypass");
      const writeToolMock = { ...writeTool, name: "write" };
      const bashToolMock = { ...writeTool, name: "bash" };

      // Write should auto-allow
      await manager.authorize("session", writeToolMock, { path: "test.txt", content: "hello" }, undefined, () => {
        throw new Error("write should auto-allow in bypass mode");
      });

      // Bash should auto-allow
      await manager.authorize("session", bashToolMock, { command: "rm -rf /" }, undefined, () => {
        throw new Error("bash should auto-allow in bypass mode");
      });
    });

    it("can switch modes dynamically", async () => {
      const manager = new PermissionManager("plan");
      const writeToolMock = { ...writeTool, name: "write" };

      // In plan mode, writes are hard-denied
      await assert.rejects(
        manager.authorize("session", writeToolMock, { path: "test.txt", content: "hello" }, undefined, () => {
          throw new Error("plan mode must not open interactive approval");
        }),
        /Permission denied.*plan mode/,
      );

      // Switch to bypass mode
      manager.setMode("bypass");

      // Now should auto-allow
      await manager.authorize("session", writeToolMock, { path: "test2.txt", content: "world" }, undefined, () => {
        throw new Error("write should auto-allow after switching to bypass mode");
      });
    });

    it("serializes and deserializes state correctly", async () => {
      const manager = new PermissionManager("bypass");
      await manager.authorize("session", writeTool, { path: "test.txt", content: "hello" }, undefined, () => {
        throw new Error("bypass should not request approval");
      });

      const serialized = manager.serialize();
      const parsed = JSON.parse(serialized);
      assert.equal(parsed.mode, "bypass");

      const manager3 = new PermissionManager("plan");
      manager3.deserialize(serialized);
      assert.equal(manager3.getMode(), "bypass");
      await manager3.authorize("session", writeTool, { path: "test.txt", content: "hello" }, undefined, () => {
        throw new Error("deserialized bypass mode should allow write without prompting");
      });
    });

    it("maps unknown deserialized modes to plan", () => {
      const manager = new PermissionManager("bypass");
      manager.deserialize(JSON.stringify({ mode: "manual", approved: [] }));
      assert.equal(manager.getMode(), "plan");

      manager.setMode("bypass");
      manager.deserialize(JSON.stringify({ mode: "auto", approved: [] }));
      assert.equal(manager.getMode(), "plan");
    });

    it("handles invalid deserialization gracefully", () => {
      const manager = new PermissionManager("plan");
      manager.deserialize("invalid json");
      assert.equal(manager.getMode(), "plan");
    });

    it("calls onPermissionEvent callback for all events", async () => {
      // Test bypass mode - should trigger allow event but not onRequest
      const bypassManager = new PermissionManager("bypass");
      const events: Array<{ type: string; tool: string }> = [];
      bypassManager.onPermissionEvent = (event) => {
        events.push({ type: event.type, tool: event.request.tool });
      };
      await bypassManager.authorize("session", writeTool, { path: "test.txt" }, undefined, () => {
        throw new Error("should not request permission in bypass mode");
      });
      assert.equal(events.length, 1);
      assert.equal(events[0]?.type, "allow");
      assert.equal(events[0]?.tool, "write");

      // Test plan mode - should trigger request + deny events and hard-fail
      const planManager = new PermissionManager("plan");
      const planEvents: Array<{ type: string; tool: string; id: string }> = [];
      planManager.onPermissionEvent = (event) => {
        planEvents.push({ type: event.type, tool: event.request.tool, id: event.request.id });
      };
      await assert.rejects(
        planManager.authorize("session", writeTool, { path: "test.txt" }, undefined, () => {
          // noop
        }),
        /Permission denied.*plan mode/,
      );
      assert.equal(planEvents.length, 2);
      assert.equal(planEvents[0]?.type, "request");
      assert.equal(planEvents[0]?.tool, "write");
      assert.equal(planEvents[1]?.type, "deny");
    });

    it("enforces the plan/bypass matrix through one turn context", async () => {
      const makeTool = (kind: "read" | "write" | "bash" | "mcp"): Tool => {
        if (kind === "bash") return { ...writeTool, name: "bash" };
        if (kind === "mcp") {
          return {
            ...writeTool,
            name: "read",
            source: { kind: "mcp", serverId: "matrix", toolName: "read" },
          };
        }
        return { ...writeTool, name: kind };
      };

      const matrix: Array<{ mode: PermissionMode; kind: "read" | "write" | "bash" | "mcp"; args: Record<string, unknown>; outcome: "allow" | "deny" }> = [
        { mode: "plan", kind: "read", args: {}, outcome: "allow" },
        { mode: "plan", kind: "write", args: {}, outcome: "deny" },
        { mode: "plan", kind: "bash", args: { command: "printf ok" }, outcome: "allow" },
        { mode: "plan", kind: "bash", args: { command: "rm -rf /tmp/x" }, outcome: "deny" },
        { mode: "plan", kind: "mcp", args: {}, outcome: "deny" },
        { mode: "bypass", kind: "read", args: {}, outcome: "allow" },
        { mode: "bypass", kind: "write", args: {}, outcome: "allow" },
        { mode: "bypass", kind: "bash", args: { command: "rm -rf /tmp/x" }, outcome: "allow" },
        { mode: "bypass", kind: "mcp", args: {}, outcome: "allow" },
      ];

      for (const testCase of matrix) {
        const manager = new PermissionManager(testCase.mode);
        const tool = makeTool(testCase.kind);
        let executions = 0;
        const executable = { ...tool, execute: async () => { executions += 1; return { content: "ok" }; } };
        const turn = manager.beginTurn("matrix", () => {
          throw new Error(`${testCase.mode}/${testCase.kind} must not open interactive approval`);
        });
        const pending = turn.execute(executable, testCase.args);
        const settled = pending.then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error }),
        );

        if (testCase.outcome === "allow") {
          const result = await settled;
          assert.equal(result.ok, true, `${testCase.mode}/${testCase.kind} should be allowed`);
          assert.equal(executions, 1, `${testCase.mode}/${testCase.kind} should execute exactly once`);
        } else {
          const result = await settled;
          assert.equal(result.ok, false, `${testCase.mode}/${testCase.kind} should be denied`);
          assert.equal(executions, 0, `${testCase.mode}/${testCase.kind} must not execute`);
        }
        turn.close();
      }
    });

    it("hard-denies Plan MCP calls without entering approval or executing", async () => {
      const manager = new PermissionManager("plan");
      const mcpTool: Tool = {
        ...writeTool,
        name: "bash",
        source: { kind: "mcp", serverId: "plan-test", toolName: "search" },
      };
      let requestCount = 0;
      let executionCount = 0;
      const turn = manager.beginTurn("plan", () => { requestCount += 1; });
      const pending = turn.execute({ ...mcpTool, execute: async () => { executionCount += 1; return { content: "bad" }; } }, { command: "printf ok" });
      await assert.rejects(pending, /plan mode/);
      assert.equal(requestCount, 0);
      assert.equal(executionCount, 0);
      turn.close();
    });

    it("cancels an in-flight tool and rejects its late result after a mode switch", async () => {
      const manager = new PermissionManager("bypass");
      let toolSignal: AbortSignal | undefined;
      let release: (() => void) | undefined;
      const turn = manager.beginTurn("in-flight", () => {});
      const pending = turn.execute({
        ...writeTool,
        name: "read",
        execute: async (_args, signal) => {
          toolSignal = signal;
          await new Promise<void>((resolve) => { release = resolve; });
          return { content: "late" };
        },
      }, {});
      await new Promise((resolve) => setImmediate(resolve));
      assert.ok(toolSignal);
      manager.setMode("plan");
      assert.equal(toolSignal?.aborted, true);
      release?.();
      await assert.rejects(pending, (error: unknown) => error instanceof PermissionModeChangedError);
      turn.close();
    });

    it("does not interrupt an active turn when setting the same mode", async () => {
      const manager = new PermissionManager("plan");
      const turn = manager.beginTurn("same", () => {});
      const change = manager.setMode("plan");
      assert.equal(change.changed, false);
      assert.equal(change.interrupted, false);
      assert.equal(turn.signal.aborted, false);
      turn.close();
    });

    it("interrupts an active turn when switching plan ↔ bypass", async () => {
      const manager = new PermissionManager("plan");
      let executions = 0;
      const turn = manager.beginTurn("switch", () => {});
      // Start a slow allow-listed tool so the mode switch can abort it.
      const pending = turn.execute({
        ...writeTool,
        name: "read",
        execute: async (_args, signal) => {
          await new Promise<void>((resolve, reject) => {
            if (signal?.aborted) {
              reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
              return;
            }
            const onAbort = () => {
              signal?.removeEventListener("abort", onAbort);
              reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
            };
            signal?.addEventListener("abort", onAbort, { once: true });
            setTimeout(() => {
              signal?.removeEventListener("abort", onAbort);
              executions += 1;
              resolve();
            }, 50);
          });
          return { content: "stale" };
        },
      }, {});
      await new Promise((resolve) => setImmediate(resolve));
      const change = manager.setMode("bypass");
      assert.deepEqual(change, {
        changed: true,
        previousMode: "plan",
        mode: "bypass",
        previousRevision: 0,
        revision: 1,
        interrupted: true,
      });
      await assert.rejects(pending, (error: unknown) =>
        error instanceof PermissionModeChangedError ||
        (error instanceof Error && error.name === "AbortError"),
      );
      assert.equal(executions, 0);
      turn.close();
    });
  });
});
