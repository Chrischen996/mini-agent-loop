import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { InMemorySkillRegistry, createPromptSkill, loadSkillNamesFromEnv, loadSkillsFromDirectory } from "../src/skills/index.ts";
import { runAgentLoop } from "../src/loop.ts";
import { makeLlmConfig } from "../src/llm/index.ts";

const llm = makeLlmConfig({ apiKey: "test", baseUrl: "http://localhost/v1", model: "faux" });

describe("skills", () => {
  it("registers, resolves, deduplicates, and unregisters skills", () => {
    const registry = new InMemorySkillRegistry();
    const skill = createPromptSkill("research", "Research helper", "Use evidence.");
    registry.register(skill);
    assert.deepEqual(registry.resolve(["research", "research", "missing"]), [skill]);
    assert.equal(registry.unregister("research"), true);
    assert.equal(registry.get("research"), undefined);
  });

  it("loads comma-separated skill names from the environment", () => {
    assert.deepEqual(loadSkillNamesFromEnv({ MINI_AGENT_SKILLS: " research, ,code " }), ["research", "code"]);
  });

  it("discovers SKILL.md files with optional frontmatter", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mini-agent-skills-"));
    try {
      await mkdir(path.join(root, "research"));
      await writeFile(path.join(root, "research", "SKILL.md"), "---\nname: repo-research\ndescription: Inspect repositories\n---\nRead the relevant source before answering.");
      const skills = await loadSkillsFromDirectory(root);
      assert.equal(skills.length, 1);
      assert.equal(skills[0]?.name, "repo-research");
      assert.equal(skills[0]?.description, "Inspect repositories");
      assert.match(skills[0]?.systemPromptFragment ?? "", /relevant source/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs hooks and injects the skill prompt into the model context", async () => {
    const phases: string[] = [];
    let capturedSystem = "";
    const skill = {
      name: "test-skill",
      description: "test",
      systemPromptFragment: "Always cite evidence.",
      hooks: {
        beforeTurn: async () => { phases.push("before"); },
        afterTurn: async () => { phases.push("after"); },
      },
    };
    const messages = await runAgentLoop("hello", {
      llm,
      tools: [],
      skills: [skill],
      chat: async (_config, context) => {
        capturedSystem = String(context.find((message) => message.role === "system")?.content ?? "");
        return { role: "assistant", content: "done" };
      },
    });
    assert.match(capturedSystem, /Always cite evidence/);
    assert.deepEqual(phases, ["before", "after"]);
    assert.equal(messages.at(-1)?.role, "assistant");
  });
});
