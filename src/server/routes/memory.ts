/**
 * `/api/memory` — persistent agent memory records.
 */

import type { Express } from "express";
import type { MemoryScope, MemoryStore } from "../../orchestration/index.ts";

const MEMORY_SCOPES: readonly MemoryScope[] = ["user", "project", "directory", "task"];

function isMemoryScope(value: unknown): value is MemoryScope {
  return typeof value === "string" && (MEMORY_SCOPES as readonly string[]).includes(value);
}

export type MemoryRoutesContext = {
  memoryStore: MemoryStore;
};

export function registerMemoryRoutes(app: Express, context: MemoryRoutesContext): void {
  const { memoryStore } = context;

  app.get("/api/memory", async (request, response) => {
    const scope = isMemoryScope(request.query.scope) ? request.query.scope : undefined;
    const query = typeof request.query.query === "string" ? request.query.query : "";
    const records = query
      ? await memoryStore.search(query, { scope })
      : await memoryStore.list({ scope });
    response.json({ records });
  });

  app.post("/api/memory", async (request, response) => {
    const scope = request.body?.scope;
    const key = typeof request.body?.key === "string" ? request.body.key.trim() : "";
    const content = typeof request.body?.content === "string" ? request.body.content.trim() : "";
    if (!isMemoryScope(scope) || !key || !content) {
      response.status(400).json({ error: "scope, key, and content are required" });
      return;
    }
    const record = await memoryStore.add({
      scope,
      key,
      content,
      source: typeof request.body?.source === "string" ? request.body.source : undefined,
    });
    response.status(201).json({ record });
  });

  app.post("/api/memory/:id/confirm", async (request, response) => {
    const record = await memoryStore.confirm(request.params.id);
    if (!record) {
      response.status(404).json({ error: "Memory record not found" });
      return;
    }
    response.json({ record });
  });

  app.delete("/api/memory/:id", async (request, response) => {
    const record = await memoryStore.forget(request.params.id);
    if (!record) {
      response.status(404).json({ error: "Memory record not found" });
      return;
    }
    response.json({ record });
  });
}
