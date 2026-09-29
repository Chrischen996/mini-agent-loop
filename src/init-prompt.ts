/**
 * Prompt used when /init runs through the agent loop.
 *
 * Injected as a user message so the LLM can interleave tool calls (read,
 * ls, grep) to survey the project and write AGENT.MD with the write tool,
 * instead of relying on a one-shot bounded snapshot. The turn is wrapped
 * in a temporary bypass permission mode and the user's previous mode is
 * restored afterwards (see App.tsx handleSubmit).
 *
 * The deterministic template path in init-agent-md.ts is still used by
 * /init --print and by the CLI, which stay model-free.
 */

export type InitPromptOptions = {
  /** True for /init --force: the user explicitly allows replacing existing content. */
  force?: boolean;
};

const SURVEY_BULLETS = [
  "- Read package.json (all scripts, not just test/build/typecheck)",
  "- Check for pnpm-workspace.yaml, turbo.json, nx.json, lerna.json",
  "- Read README.md for the project overview",
  "- List the skills/ directory and summarize each skill's purpose",
  "- List docs/ and note key documents (architecture, security, etc.)",
  "- Check the scripts/ and plans/ directories",
  "- Read tsconfig.json for TypeScript settings",
  "- Check .gitignore for excluded patterns",
  "- Look for existing AI config files (.cursorrules, CLAUDE.md, .github/copilot-instructions.md) and import useful conventions",
];

const SECTION_BULLETS = [
  "- # Agent Instructions",
  "- ## Project — concise description of what this project is and its architecture",
  "- ## Commands — all relevant npm/pnpm scripts with one-line descriptions",
  "- ## Code Style & Guidelines — concrete rules specific to this codebase",
  "- ## Testing & Verification — how to validate changes",
];

export function buildInitAgentPrompt(options: InitPromptOptions = {}): string {
  const existingRule = options.force
    ? "The user explicitly requested regeneration with --force, so you may replace the existing file wholesale (still preserve facts that remain accurate)."
    : "Do not silently overwrite rich content; only update or replace it if the current file is a blank template or missing key sections.";
  return [
    "Run the /init flow: create or update AGENT.MD in the current working directory using your file tools. It is the contributor and agent instructions document for this repository.",
    "",
    `Before writing, check whether AGENT.MD already exists. If it does, read it first — ${existingRule}`,
    "",
    "Survey the project thoroughly:",
    ...SURVEY_BULLETS,
    "",
    "Write AGENT.MD with these sections (adapt as needed):",
    ...SECTION_BULLETS,
    "",
    "Rules:",
    "- Be specific to THIS project. No generic advice.",
    "- Omit sections that don't apply; add sections that are relevant.",
    "- Only touch AGENT.MD: do not modify any other file.",
    "- Limit shell commands to read-only inspection (ls, cat, grep, find, git log/status).",
    "- After writing, reply with a single line summarizing what was created or updated; do not paste the file content.",
  ].join("\n");
}
