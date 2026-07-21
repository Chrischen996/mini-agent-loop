import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "mini-agent-test-mcp", version: "1.0.0" },
  { capabilities: { tools: { listChanged: true } } },
);

let refreshed = false;

server.setRequestHandler(ListToolsRequestSchema, async (request) => {
  if (request.params?.cursor === "page-2") {
    return {
      tools: [
        {
          name: "delay",
          description: "Wait briefly before returning",
          inputSchema: {
            type: "object",
            properties: { milliseconds: { type: "number" } },
            required: ["milliseconds"],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: true },
        },
        {
          name: "background-task",
          description: "Requires the MCP task capability",
          inputSchema: { type: "object", properties: {} },
          execution: { taskSupport: "required" },
        },
        {
          name: "refresh-tools",
          description: "Change the tool catalog and send tools/list_changed",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        },
        {
          name: "shutdown",
          description: "Exit this fixture process after responding",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        },
      ],
    };
  }
  return {
    tools: [
      {
        name: refreshed ? "echo-v2" : "echo",
        title: "Echo",
        description: "Echo text",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true, idempotentHint: true },
      },
    ],
    nextCursor: "page-2",
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "echo" || request.params.name === "echo-v2") {
    const text = String(request.params.arguments?.text ?? "");
    return {
      content: [{ type: "text", text: `echo:${text}` }],
      structuredContent: { echoed: text },
    };
  }
  if (request.params.name === "delay") {
    const milliseconds = Number(request.params.arguments?.milliseconds ?? 0);
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
    return { content: [{ type: "text", text: "delay:done" }] };
  }
  if (request.params.name === "refresh-tools") {
    refreshed = true;
    await server.sendToolListChanged();
    return { content: [{ type: "text", text: "tools:refreshed" }] };
  }
  if (request.params.name === "shutdown") {
    setTimeout(() => process.exit(0), 10);
    return { content: [{ type: "text", text: "server:shutting-down" }] };
  }
  return {
    content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }],
    isError: true,
  };
});

await server.connect(new StdioServerTransport());
