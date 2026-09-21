/**
 * `/api/sessions/:id/files/:fileId` — download artifacts produced by a session.
 */

import { createReadStream, existsSync } from "node:fs";
import type { Express } from "express";
import type { DocumentStore } from "../../documents.ts";
import { errorMessage } from "./types.ts";

export type FileRoutesContext = {
  hasSession: (id: string) => boolean;
  documentStore: DocumentStore;
};

export function registerFileRoutes(app: Express, context: FileRoutesContext): void {
  const { documentStore } = context;
  const sessions = { has: context.hasSession };

  app.get("/api/sessions/:id/files/:fileId", async (request, response) => {
    if (!sessions.has(request.params.id)) {
      response.status(404).json({ error: "Session not found" });
      return;
    }
    try {
      const output = documentStore.getOutput(request.params.id, request.params.fileId);
      if (!existsSync(output.path)) {
        response.status(404).json({ error: "File not found" });
        return;
      }
      response.setHeader("Content-Type", output.artifact.mimeType);
      response.setHeader("Content-Length", String(output.artifact.size));
      response.setHeader("Content-Disposition", `attachment; filename="${output.artifact.name}"`);
      createReadStream(output.path).on("error", (error) => {
        if (!response.headersSent) response.status(404).json({ error: error.message });
        else response.destroy(error);
      }).pipe(response);
    } catch (error) {
      response.status(404).json({ error: errorMessage(error) });
    }
  });
}
