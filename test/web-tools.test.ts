import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DocumentStore } from "../src/documents.ts";
import { createTools } from "../src/tools/index.ts";
import {
  createWebWorkspaceToolProvider,
  createWebSessionToolProvider,
} from "../src/server/web-tools.ts";
import { resolveToolProvider, type Tool } from "../src/tools/types.ts";

describe("Web UI Tools vs CLI Tools separation", () => {
  it("CLI tools default set does not include Web-specific document_edit tool", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "mini-agent-tools-cli-"));
    try {
      const cliTools = createTools(tempDir);
      const names = cliTools.map((t) => t.name);
      assert.ok(names.includes("read"), "CLI should have read tool");
      assert.ok(names.includes("write"), "CLI should have write tool");
      assert.ok(names.includes("bash"), "CLI should have bash tool");
      assert.ok(!names.includes("document_edit"), "CLI tools should not include document_edit");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("createWebWorkspaceToolProvider isolates workspace tools and gates MCP tools", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "mini-agent-web-tools-ws-"));
    try {
      let mcpApproved = false;
      const fakeMcpTool: Tool = {
        name: "mcp_custom_tool",
        description: "Test MCP tool",
        parameters: { type: "object" },
        source: { kind: "mcp", serverId: "test-server" },
        execute: async () => ({ content: "mcp-result" }),
      };

      const provider = createWebWorkspaceToolProvider({
        workspace: tempDir,
        codebaseEnabled: false,
        mcpTools: [fakeMcpTool],
        mcpApproval: async () => {
          mcpApproved = true;
        },
      });

      const tools = resolveToolProvider(provider);
      const mcpTool = tools.find((t) => t.name === "mcp_custom_tool");
      assert.ok(mcpTool, "MCP tool should be present in web workspace tool provider");

      const result = await mcpTool.execute({});
      assert.equal(result.content, "mcp-result");
      assert.equal(mcpApproved, true, "MCP approval gate should have been called");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("createWebSessionToolProvider encapsulates document_edit and session-scoped todo tools", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "mini-agent-web-tools-session-"));
    try {
      const docStore = new DocumentStore(path.join(tempDir, "docs"));
      let updatedTodos: unknown = null;

      const baseProvider = createWebWorkspaceToolProvider({
        workspace: tempDir,
        codebaseEnabled: false,
      });

      const sessionProvider = createWebSessionToolProvider({
        sessionId: "sess-123",
        workspace: tempDir,
        operationScope: "scope-abc",
        documentStore: docStore,
        updateTodos: async (todos) => {
          updatedTodos = todos;
        },
        baseTools: baseProvider,
      });

      const tools = resolveToolProvider(sessionProvider);
      const names = tools.map((t) => t.name);

      assert.ok(names.includes("read"), "Web session should include workspace read tool");
      assert.ok(names.includes("document_edit"), "Web session should encapsulate document_edit tool");
      assert.ok(names.includes("todo_write") || names.includes("TodoWrite"), "Web session should include todo tool");

      // Verify todo tool mutation targets the specific session callback
      const todoTool = tools.find((t) => t.name === "todo_write" || t.name === "TodoWrite");
      assert.ok(todoTool, "Todo tool must exist");
      await todoTool.execute({
        todos: [{ id: "task-1", content: "Test Task", activeForm: "Testing", status: "in_progress" }],
      });
      assert.ok(Array.isArray(updatedTodos), "updateTodos callback should be invoked");
      assert.equal((updatedTodos as any[])[0]?.content, "Test Task");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
