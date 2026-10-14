import assert from "node:assert/strict";
import { it } from "node:test";
import { api } from "../apps/web/src/lib/api.ts";

it("sends image and document attachments as multipart fields", async () => {
  const originalFetch = globalThis.fetch;
  let captured: RequestInit | undefined;
  globalThis.fetch = (async (_input: string | URL, init?: RequestInit) => {
    captured = init;
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  try {
    const image = new File(["image"], "chart.png", { type: "image/png" });
    const document = new File(["document"], "notes.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
    await api.sendPrompt("session-1", "Summarize", [image, document]);
    assert.equal(captured?.method, "POST");
    assert.equal(captured?.headers, undefined, "fetch should set the multipart boundary itself");
    const body = captured?.body as FormData;
    assert.equal(body.get("prompt"), "Summarize");
    assert.equal((body.get("images") as File).name, "chart.png");
    assert.equal((body.get("documents") as File).name, "notes.docx");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
