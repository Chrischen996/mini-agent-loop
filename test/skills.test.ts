import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  InMemorySkillRegistry,
  activateSkillNames,
  applySkillCommand,
  createPromptSkill,
  discoverWorkspaceSkills,
  formatActivatedSkillPrompt,
  formatSkillCatalog,
  formatSkillStatus,
  loadSkillNamesFromEnv,
  loadSkillsFromDirectory,
  uniqueSkillNames,
} from "../src/skills/index.ts";
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

  it("discovers SKILL.md files from official workspace and user skill directories", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mini-agent-workspace-skills-"));
    const home = await mkdtemp(path.join(tmpdir(), "mini-agent-home-skills-"));
    const registry = new InMemorySkillRegistry();
    try {
      await mkdir(path.join(root, "skills", "research"), { recursive: true });
      await mkdir(path.join(root, ".grok", "skills", "linter"), { recursive: true });
      await mkdir(path.join(root, ".claude", "skills", "review"), { recursive: true });
      await mkdir(path.join(home, ".claude", "skills", "pdf-processing", "scripts"), { recursive: true });
      await mkdir(path.join(home, ".claude", "skills", "pdf-processing", "references"), { recursive: true });
      await writeFile(
        path.join(root, "skills", "research", "SKILL.md"),
        "---\nname: repo-research\ndescription: Inspect repositories\n---\nRead the source first.",
      );
      await writeFile(
        path.join(root, ".grok", "skills", "linter", "SKILL.md"),
        "Always run the linter.",
      );
      await writeFile(
        path.join(root, ".claude", "skills", "review", "SKILL.md"),
        "---\nname: review\ndescription: Review local changes\n---\nLeave review comments.",
      );
      await writeFile(
        path.join(home, ".claude", "skills", "pdf-processing", "SKILL.md"),
        "---\nname: pdf-processing\ndescription: Extract and merge PDFs\n---\nUse the bundled scripts.",
      );
      await writeFile(path.join(home, ".claude", "skills", "pdf-processing", "scripts", "extract.py"), "print('ok')\n");
      await writeFile(path.join(home, ".claude", "skills", "pdf-processing", "references", "FORMS.md"), "Form notes\n");
      const discovered = await discoverWorkspaceSkills(root, registry, home);
      assert.equal(discovered.skills.length, 4);
      assert.deepEqual(
        registry.list().map((skill) => skill.name).sort(),
        ["linter", "pdf-processing", "repo-research", "review"],
      );
      const pdf = registry.get("pdf-processing");
      assert.ok(pdf?.sourceDir?.endsWith(path.join("pdf-processing")));
      assert.deepEqual(pdf?.scripts, ["extract.py"]);
      assert.deepEqual(pdf?.references, ["FORMS.md"]);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });

  it("activates registered names and formats status", () => {
    const registry = new InMemorySkillRegistry();
    registry.register(createPromptSkill("research", "Research helper", "Use evidence."));
    assert.deepEqual(uniqueSkillNames([" research ", "research", ""]), ["research"]);
    const activation = activateSkillNames(["research", "missing"], registry);
    assert.deepEqual(activation.activeNames, ["research"]);
    assert.deepEqual(activation.missingNames, ["missing"]);
    assert.match(formatSkillStatus(activation), /Active: research/);
    assert.match(formatSkillStatus(activation), /\* research/);
    assert.match(formatSkillStatus(activation), /Missing: missing/);
  });

  it("parses /skill commands for the current session", () => {
    const registry = new InMemorySkillRegistry();
    registry.register(createPromptSkill("research", "Research helper", "Use evidence."));
    registry.register(createPromptSkill("code", "Code helper", "Inspect the repo."));
    assert.equal(applySkillCommand("/help", [], registry), undefined);
    assert.deepEqual(applySkillCommand("/skill research", [], registry)?.activation.activeNames, ["research"]);
    assert.deepEqual(applySkillCommand("/skills on code", ["research"], registry)?.activation.activeNames, ["research", "code"]);
    assert.deepEqual(applySkillCommand("/skill off research", ["research", "code"], registry)?.activation.activeNames, ["code"]);
    assert.deepEqual(applySkillCommand("/skills only research", ["code"], registry)?.activation.activeNames, ["research"]);
    assert.deepEqual(applySkillCommand("/skill clear", ["research"], registry)?.activation.activeNames, []);
  });

  it("injects a catalog for discovered skills and full instructions only when activated", async () => {
    const registry = new InMemorySkillRegistry();
    const catalog = {
      name: "review",
      description: "Review local changes",
      systemPromptFragment: "Leave review comments on every file.",
    };
    const activated = {
      name: "pdf-processing",
      description: "Extract and merge PDFs",
      systemPromptFragment: "Use the bundled scripts.",
      sourceDir: "/tmp/pdf-processing",
      scripts: ["extract.py"],
      references: ["FORMS.md"],
    };
    registry.register(catalog);
    registry.register(activated);
    let capturedSystem = "";
    await runAgentLoop("hello", {
      llm,
      tools: [],
      skillNames: ["pdf-processing"],
      skillRegistry: registry,
      chat: async (_config, context) => {
        capturedSystem = String(context.find((message) => message.role === "system")?.content ?? "");
        return { role: "assistant", content: "done" };
      },
    });
    assert.match(capturedSystem, /Available Skills/);
    assert.match(capturedSystem, /review: Review local changes/);
    assert.doesNotMatch(capturedSystem, /Leave review comments on every file/);
    assert.match(capturedSystem, /Use the bundled scripts/);
    assert.match(capturedSystem, /Skill directory: \/tmp\/pdf-processing/);
    assert.match(capturedSystem, /Scripts: extract.py/);
    assert.match(formatSkillCatalog([catalog]), /review: Review local changes/);
    assert.match(formatActivatedSkillPrompt(activated), /Do not invent missing files/);
  });

  it("records resolved skill names on the parent runtime snapshot", async () => {
    const runtimeRef: { skillNames?: string[] } = {};
    await runAgentLoop("hello", {
      llm,
      tools: [],
      skills: [createPromptSkill("research", "Research helper", "Use evidence.")],
      runtimeRef,
      chat: async () => ({ role: "assistant", content: "done" }),
    });
    assert.deepEqual(runtimeRef.skillNames, ["research"]);
  });
});
