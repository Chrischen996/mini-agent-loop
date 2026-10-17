import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { historyToItems } from "../apps/web/src/lib/event-adapter.ts";
import { toolCard } from "../apps/web/src/lib/tool-card.ts";

describe("web tool cards", () => {
  it("keeps a bash command on the row and in the terminal card", () => {
    const items = historyToItems([
      { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "bash", arguments: { command: "ls src" } }] },
      { role: "tool", toolCallId: "t1", name: "bash", content: "loop.ts\n", isError: false },
    ]);
    const tool = items.find((item) => item.kind === "tool");
    assert.ok(tool?.kind === "tool");
    const card = toolCard(tool);
    assert.equal(card.kind, "bash");
    assert.equal(card.title, "Bash");
    assert.equal(card.summary, "ls src");
    assert.equal(card.command, "ls src");
    assert.match(card.output ?? "", /loop\.ts/);
    assert.equal(card.expandable, true);
  });

  it("numbers a read card from the call offset and keeps the path", () => {
    const items = historyToItems([
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "r1", name: "read", arguments: { path: "src/loop.ts", offset: 12 } }],
      },
      { role: "tool", toolCallId: "r1", name: "read", content: "alpha\nbeta\n", isError: false },
    ]);
    const tool = items.find((item) => item.kind === "tool");
    assert.ok(tool?.kind === "tool");
    const card = toolCard(tool);
    assert.equal(card.summary, "src/loop.ts");
    assert.deepEqual(card.lines?.map((line) => line.number), [12, 13, 14]);
    assert.equal(card.lines?.[0]?.text, "alpha");
  });

  it("shows an edit path, size, and the replacement on the mutation card", () => {
    const card = toolCard({
      name: "edit",
      status: "ok",
      preview: "Successfully replaced 1 block(s) in src/loop.ts.",
      path: "src/loop.ts",
      args: { path: "src/loop.ts", edits: [{ oldText: "const limit = 30", newText: "const limit = 80" }] },
      inputBytes: "const limit = 30".length + "const limit = 80".length,
    });
    assert.equal(card.kind, "mutate");
    assert.equal(card.summary, "src/loop.ts");
    assert.equal(card.suffix, "1KB");
    assert.equal(card.changes?.[0]?.kind, "removed");
    assert.match(card.changes?.[1]?.text ?? "", /limit = 80/);
  });

  it("replaces a failed summary with the first error line and drops the size", () => {
    const card = toolCard({
      name: "write",
      status: "error",
      preview: "path escapes the workspace\nmore",
      path: "secret.txt",
      inputBytes: 4000,
    });
    assert.equal(card.summary, "path escapes the workspace more");
    assert.equal(card.summaryTone, "error");
    assert.equal(card.suffix, undefined);
    assert.equal(card.statusLabel, "Failed");
  });

  it("uses the search pattern as the row summary", () => {
    const card = toolCard({
      name: "grep",
      status: "running",
      preview: "",
      args: { pattern: "maxTurns", path: "src" },
    });
    assert.equal(card.kind, "search");
    assert.equal(card.title, "Grep");
    assert.equal(card.summary, "maxTurns");
    assert.equal(card.statusLabel, "Running");
    assert.equal(card.expandable, true);
  });
});
