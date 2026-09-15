/**
 * End-to-end smoke for the M1 pipeline orchestrator (Route A, design doc
 * docs/multi-agent-orchestration-design.md §8-M1).
 *
 * Drives ONE trivial TaskSpec through the full loop with a REAL LLM:
 *
 *   coder subagent (worker window) → structured WorkerResult callback
 *   → acceptance gates (status / file-scope / independent reviewer subagent)
 *   → RunSummary (§6/§7 closed loop)
 *
 * Usage:
 *   npx tsx scripts/pipeline-smoke.ts                 # active profile / .env
 *   npx tsx scripts/pipeline-smoke.ts --profile deepseek-deepseek-v4-flash
 *   npx tsx scripts/pipeline-smoke.ts --clean           # remove examples/pipeline-smoke/ afterwards
 *   npx tsx scripts/pipeline-smoke.ts --full [--profile X] [--clean]
 *                                        # M2+M3 chain: split requirement → parallel
 *                                        # development (maxConcurrency=2) → acceptance
 *
 * Cost note: this makes 2 subagent LLM conversations (worker + reviewer),
 * plus iteration re-dispatches if the review gate fails (maxIter=2).
 * Without `--profile`, the model comes from the active profile / .env
 * (loadLlmConfigFromEnv).
 *
 * Rollback: the smoke only touches examples/pipeline-smoke/ — delete the
 * directory to roll back.
 */
import { rm, access } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { loadLlmConfigFromEnv, makeLlmConfig } from "../src/llm/index.ts";
import { loadProfileStoreSync } from "../src/profile-store.ts";
import { createDefaultTools } from "../src/tools/index.ts";
import {
  analyzeRequirement,
  PipelineOrchestrator,
  type PipelineLogEvent,
  type TaskSpec,
} from "../src/orchestration/pipeline/index.ts";

// ─── .env loading ─────────────────────────────────────────────────────────

/**
 * Load the workspace `.env` into `process.env` (without overriding vars that
 * are already set). Subagent model switches resolve provider API keys from
 * the environment (`DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, ...), so the smoke
 * needs the local .env values visible to `process.env`.
 */
function loadDotEnv(): void {
  let text: string;
  try {
    text = readFileSync(join(process.cwd(), ".env"), "utf8");
  } catch {
    return; // no .env file — rely on the inherited environment
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

// ─── The smoke task: deliberately trivial and self-contained ─────────────────

const SMOKE_DIR = join(process.cwd(), "examples", "pipeline-smoke");

const spec: TaskSpec = {
  id: "S-001",
  title: "Smoke: hello utility",
  context: "TypeScript ESM project, run with tsx. Keep all changes inside examples/pipeline-smoke/.",
  instruction: [
    "Create a new file examples/pipeline-smoke/hello.ts that:",
    "- exports `function hello(name: string): string` returning `Hello, ${name}!`",
    "- when executed directly (`import.meta.url === process.argv[1]`-style main-module guard, or simply at the end of the file), prints `hello(\"pipeline\")` to stdout",
    "Verify by running: npx tsx examples/pipeline-smoke/hello.ts",
    "Only create/modify files under examples/pipeline-smoke/. If you must touch anything else, declare it in the result `notes` field.",
  ].join("\n"),
  acceptance: [
    "examples/pipeline-smoke/hello.ts exists and exports hello(name: string)",
    "Running `npx tsx examples/pipeline-smoke/hello.ts` prints exactly `Hello, pipeline!`",
  ],
  files_hint: [join("examples", "pipeline-smoke", "hello.ts")],
  // "light" so the orchestrator exercises the model-mapping path; we map it
  // to the active model to keep the smoke to a single provider.
  model_hint: "light",
};

function resolveLlm(): ReturnType<typeof loadLlmConfigFromEnv> {
  const args = process.argv.slice(2);
  const profileName =
    args.find((a) => a === "--profile")
      ? args[args.indexOf("--profile") + 1]
      : args.find((a) => a.startsWith("--profile="))?.slice("--profile=".length);
  if (!profileName) return loadLlmConfigFromEnv();
  const store = loadProfileStoreSync();
  const profile = store?.profiles?.[profileName];
  if (profile === undefined) {
    throw new Error(
      `profile "${profileName}" not found. Known profiles: ${Object.keys(store?.profiles ?? {}).join(", ")}`,
    );
  }
  return makeLlmConfig({
    apiKey: profile.apiKey,
    baseUrl: profile.baseUrl,
    model: profile.model,
    ...(profile.thinkingLevel !== undefined ? { thinkingLevel: profile.thinkingLevel } : {}),
  });
}

// ─── M2+M3 full-chain smoke: split → parallel develop → accept ────────────────────

const FULL_DIR = join("examples", "pipeline-smoke", "full");

const FULL_REQUIREMENT = [
  "Build two INDEPENDENT utility modules under examples/pipeline-smoke/full/ (create the directory):",
  '1. greet.ts — export `function greet(name: string): string` returning "Hello, <name>!". When executed directly it must print exactly: Hello, pipeline!',
  '2. farewell.ts — export `function farewell(name: string): string` returning "Bye, <name>!". When executed directly it must print exactly: Bye, pipeline!',
  "The two files must not import each other. Keep ALL changes inside examples/pipeline-smoke/full/.",
  "Each task's acceptance must be verifiable by running `npx tsx <file>` and checking stdout.",
].join("\n");

const FULL_PROJECT_CONTEXT =
  "TypeScript ESM project executed with tsx (Node >= 22). Paths are workspace-relative. " +
  'Main-module guard example: `if (path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) { ... }`';

/** Run a file with tsx; returns trimmed stdout, or undefined when it fails. */
function runWithTsx(file: string): string | undefined {
  const res = spawnSync("npx", ["tsx", file], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 60_000,
  });
  return res.status === 0 ? res.stdout.trim() : undefined;
}

/**
 * Import a workspace-relative module in a child `tsx -e` process (where
 * `process.argv[1]` is undefined) and report whether the import survives.
 * This is the ground-truth check for the §4.8 import-safety clause: a
 * non-defensive main guard crashes exactly in this context.
 */
function importSurvives(file: string): boolean {
  const res = spawnSync(
    "npx",
    [
      "tsx",
      "-e",
      `import("./${file}").catch((error) => { console.error(String(error)); process.exit(1); });`,
    ],
    { cwd: process.cwd(), encoding: "utf8", timeout: 60_000 },
  );
  return res.status === 0;
}

/**
 * M2+M3 chain with a REAL LLM:
 *   1. analyzeRequirement splits the requirement into TaskSpec[] (M2)
 *   2. PipelineOrchestrator.run develops the specs in parallel waves
 *      (maxConcurrency=2; distinct files_hint stay in one wave) and
 *      accepts every result through the §6.1 gate pipeline (M1 loop).
 */
async function runFullMode(
  llm: ReturnType<typeof loadLlmConfigFromEnv>,
  clean: boolean,
): Promise<void> {
  const model = llm.model;
  const tools = createDefaultTools(process.cwd(), {
    tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
  });

  console.log(`[smoke:full] step 1/2 M2 split (model=${model})`);
  const split = await analyzeRequirement(FULL_REQUIREMENT, {
    parentLlm: llm,
    parentTools: tools,
    model,
    projectContext: FULL_PROJECT_CONTEXT,
    maxTasks: 4,
    onEvent: (event: PipelineLogEvent) => {
      const { ts, ...rest } = event;
      console.log(`[split] ${JSON.stringify(rest)}`);
    },
  });
  console.log(
    `[smoke:full] split → ${split.specs.length} specs (resplits=${split.resplits}): ` +
      split.specs.map((s) => `${s.id} [${s.files_hint.join(" ")}]`).join(" | "),
  );

  console.log(`[smoke:full] step 2/2 M3 parallel development + acceptance`);
  const orchestrator = new PipelineOrchestrator({
    parentLlm: llm,
    parentTools: tools,
    modelMapping: { light: model, standard: model, flagship: model },
    workspaceRoot: process.cwd(),
    maxConcurrency: 2,
    onEvent: (event: PipelineLogEvent) => {
      const { ts, ...rest } = event;
      console.log(`[event] ${rest.task_id} ${rest.event} ${JSON.stringify({ ts, ...rest })}`);
    },
  });

  const summary = await orchestrator.run(split.specs, { maxIter: 2 });
  for (const entry of summary.entries) {
    console.log(
      `[smoke:full] ${entry.spec.id} status=${entry.result.status} attempts=${entry.attempts} ` +
        `verdict=${entry.verdict?.passed ? "pass" : "fail"} ` +
        `files=${entry.spec.files_hint.join(",") || "(none)"}`,
    );
  }

  // Ground truth (do not trust the callbacks alone):
  //  a) every declared file exists on disk
  let filesOk = true;
  for (const entry of summary.entries) {
    for (const file of entry.spec.files_hint) {
      try {
        await access(join(process.cwd(), file));
      } catch {
        console.log(`[smoke:full] MISSING declared file ${file}`);
        filesOk = false;
      }
    }
  }
  //  b) the two canonical files must actually print the expected lines
  let outputsOk = true;
  for (const [file, expected] of Object.entries({
    [join(FULL_DIR, "greet.ts")]: "Hello, pipeline!",
    [join(FULL_DIR, "farewell.ts")]: "Bye, pipeline!",
  })) {
    const actual = runWithTsx(file);
    if (actual !== expected) {
      console.log(
        `[smoke:full] OUTPUT MISMATCH ${file}: ${JSON.stringify(actual)} (want ${JSON.stringify(expected)})`,
      );
      outputsOk = false;
    }
  }
  //  c) every generated module must survive a bare dynamic import (§4.8
  //     import-safety clause; the child `tsx -e` context leaves argv[1] undefined)
  let importsOk = true;
  for (const file of [join(FULL_DIR, "greet.ts"), join(FULL_DIR, "farewell.ts")]) {
    if (!importSurvives(file)) {
      console.log(`[smoke:full] IMPORT CRASH ${file} (dynamic import in tsx -e failed)`);
      importsOk = false;
    }
  }

  const exitOk = summary.ok && filesOk && outputsOk && importsOk;
  console.log(`[smoke:full] ${exitOk ? "PASS" : "FAIL"}`);

  if (clean) {
    await rm(join(process.cwd(), "examples", "pipeline-smoke"), {
      recursive: true,
      force: true,
    });
    console.log("[smoke:full] cleaned examples/pipeline-smoke/");
  }
  process.exit(exitOk ? 0 : 1);
}

async function main(): Promise<void> {
  const clean = process.argv.includes("--clean");
  const full = process.argv.includes("--full");
  loadDotEnv();
  const llm = resolveLlm();
  if (full) {
    await runFullMode(llm, clean);
    return;
  }
  console.log(`[smoke] LLM: ${llm.model} (provider=${llm.provider ?? "inherited"})`);

  const orchestrator = new PipelineOrchestrator({
    parentLlm: llm,
    parentTools: createDefaultTools(process.cwd(), {
      tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
    }),
    // Exercise the model_hint mapping (§4.6) without a second provider.
    modelMapping: { light: llm.model },
    workspaceRoot: process.cwd(),
    // Gate 3 (validate_workspace) is intentionally left out of the smoke to
    // keep cost low; the status / file-scope / reviewer gates still run.
    onEvent: (event: PipelineLogEvent) => {
      const { ts, ...rest } = event;
      console.log(`[event] ${rest.task_id} ${rest.event} ${JSON.stringify({ ts, ...rest })}`);
    },
  });

  const summary = await orchestrator.run([spec], { maxIter: 2 });
  const entry = summary.entries[0];

  console.log("\n──────────────────────────────────────────");
  console.log(`[smoke] ok=${summary.ok} attempts=${entry?.attempts}`);
  console.log(`[smoke] result = ${JSON.stringify(entry?.result, null, 2)}`);
  console.log(`[smoke] verdict = ${JSON.stringify(entry?.verdict, null, 2)}`);

  // Independent ground-truth check (do not trust the callback alone).
  let onDisk = false;
  try {
    await access(join(SMOKE_DIR, "hello.ts"));
    onDisk = true;
  } catch {
    onDisk = false;
  }
  console.log(`[smoke] file on disk: ${onDisk} (${join("examples", "pipeline-smoke", "hello.ts")})`);

  if (clean) {
    await rm(SMOKE_DIR, { recursive: true, force: true });
    console.log("[smoke] cleaned examples/pipeline-smoke/");
  }

  const verdictPassed = entry?.verdict?.passed ?? false;
  const exitOk = summary.ok && onDisk && verdictPassed;
  console.log(`[smoke] ${exitOk ? "PASS" : "FAIL"}`);
  process.exit(exitOk ? 0 : 1);
}

main().catch((error) => {
  console.error("[smoke] fatal:", error);
  process.exit(1);
});
