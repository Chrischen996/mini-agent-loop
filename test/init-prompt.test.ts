import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildInitAgentPrompt } from "../src/init-prompt.ts";

describe("buildInitAgentPrompt", () => {
  it("instructs the agent to survey the project and write AGENT.MD", () => {
    const prompt = buildInitAgentPrompt();
    assert.match(prompt, /AGENT\.MD/);
    assert.match(prompt, /package\.json/);
    assert.match(prompt, /## Commands/);
    assert.match(prompt, /## Testing & Verification/);
    assert.match(prompt, /only touch AGENT\.MD/i);
  });

  it("preserves rich existing content without --force", () => {
    const prompt = buildInitAgentPrompt();
    assert.match(prompt, /Do not silently overwrite rich content/);
    assert.doesNotMatch(prompt, /--force/);
  });

  it("allows wholesale replacement with --force", () => {
    const prompt = buildInitAgentPrompt({ force: true });
    assert.match(prompt, /--force/);
    assert.match(prompt, /replace the existing file wholesale/);
  });

  it("keeps shell usage to read-only inspection", () => {
    const prompt = buildInitAgentPrompt();
    assert.match(prompt, /read-only inspection/);
  });

  it("asks for a one-line summary instead of pasting the file", () => {
    const prompt = buildInitAgentPrompt();
    assert.match(prompt, /single line summarizing/);
  });

  it("does not keep the one-shot completion rule from the old prompt", () => {
    const prompt = buildInitAgentPrompt();
    assert.doesNotMatch(prompt, /raw Markdown only/);
  });
});
