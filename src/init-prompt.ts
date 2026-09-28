export const INIT_PROMPT = `Generate a file named AGENT.MD that serves as contributor and agent instructions for this repository.

Before writing, check whether AGENT.MD already exists in the current working directory. If it does, read it first — do not silently overwrite rich content. Only update or replace it if the current file is a blank template or missing key sections.

Survey the project thoroughly:
- Read package.json (all scripts, not just test/build/typecheck)
- Check for pnpm-workspace.yaml, turbo.json, nx.json, lerna.json
- Read README.md for project overview
- List skills/ directory and summarize each skill's purpose
- List docs/ and note key documents (architecture, security, etc.)
- Check scripts/, plans/ directories
- Read tsconfig.json for TypeScript settings
- Check .gitignore for excluded patterns
- Look for any existing AI config files (.cursorrules, CLAUDE.md, .github/copilot-instructions.md) and import useful conventions

Write AGENT.MD with these sections (adapt as needed):
- # Agent Instructions
- ## Project — concise description of what this project is and its architecture
- ## Commands — all relevant npm/pnpm scripts with one-line descriptions
- ## Code Style & Guidelines — concrete rules specific to this codebase
- ## Testing & Verification — how to validate changes

Rules:
- Be specific to THIS project. No generic advice.
- If AGENT.MD already has good content (like AGENTS.md), preserve it and only add missing pieces.
- Omit sections that don't apply; add sections that are relevant.
- Output raw Markdown only — no preamble, no code fence wrapper.`;
