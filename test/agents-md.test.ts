import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadAgentsMd, loadInstructionBundle } from "../src/agents-md.ts";
import { buildSystemPrompt } from "../src/loop.ts";

describe("loadAgentsMd", () => {
  it("returns undefined when no agents file exists", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agents-md-"));
    try {
      const result = await loadAgentsMd(dir);
      assert.equal(result, undefined);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("loads .agents.md content", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agents-md-"));
    try {
      await writeFile(path.join(dir, ".agents.md"), "# Custom Rules\nAlways write tests.");
      const result = await loadAgentsMd(dir);
      assert.equal(result, "# Custom Rules\nAlways write tests.");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("prefers .agents.md over AGENTS.md", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agents-md-"));
    try {
      await writeFile(path.join(dir, ".agents.md"), "dot-agents");
      await writeFile(path.join(dir, "AGENTS.md"), "caps-agents");
      const result = await loadAgentsMd(dir);
      assert.equal(result, "dot-agents");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("loads AGENTS.md when .agents.md is absent", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agents-md-"));
    try {
      await writeFile(path.join(dir, "AGENTS.md"), "caps content");
      const result = await loadAgentsMd(dir);
      assert.equal(result, "caps content");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("merges ancestor instructions from low to high precedence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agents-bundle-"));
    const nested = path.join(root, "repo", "src");
    try {
      await mkdir(nested, { recursive: true });
      await writeFile(path.join(root, "repo", "AGENTS.md"), "repo rules");
      await writeFile(path.join(nested, ".agents.md"), "src rules");
      const bundle = await loadInstructionBundle(nested, { includeGlobal: false });
      assert.deepEqual(bundle.sources.map((source) => source.content), ["repo rules", "src rules"]);
      assert.ok(bundle.content.indexOf("repo rules") < bundle.content.indexOf("src rules"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("buildSystemPrompt with agentsMd", () => {
  it("prepends agentsMd content when provided", () => {
    const prompt = buildSystemPrompt(undefined, "Custom rules here");
    assert.ok(prompt.startsWith("# Repository Agent Instructions"));
    assert.ok(prompt.includes("Custom rules here"));
    assert.ok(prompt.includes("You are a local file assistant"));
  });

  it("omits agentsMd section when not provided", () => {
    const prompt = buildSystemPrompt(undefined, undefined);
    assert.ok(!prompt.includes("Repository Agent Instructions"));
    assert.ok(prompt.includes("You are a local file assistant"));
  });
});

import { discoverGrokSkills } from "../src/skills/index.ts";

describe("discoverGrokSkills", () => {
  it("returns empty array when .grok/skills/ does not exist", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "grok-skills-"));
    try {
      const skills = await discoverGrokSkills(dir);
      assert.equal(skills.length, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("discovers SKILL.md files in .grok/skills/", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "grok-skills-"));
    try {
      await mkdir(path.join(dir, ".grok", "skills", "linter"), { recursive: true });
      await writeFile(
        path.join(dir, ".grok", "skills", "linter", "SKILL.md"),
        "---\nname: linter\ndescription: Run linter\n---\nAlways run the linter before committing.",
      );
      const skills = await discoverGrokSkills(dir);
      assert.equal(skills.length, 1);
      assert.equal(skills[0]!.name, "linter");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
