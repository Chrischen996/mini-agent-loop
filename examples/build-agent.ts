/**
 * build-agent.ts — A Grok-Build-style coding agent function.
 *
 * Usage:
 *   const result = await buildAgent("add error handling to auth.ts", { cwd: "/path/to/project" })
 *   console.log(result.text)
 */

import path from "node:path"
import { runAgentLoop, type LlmConfig } from "../src/loop.ts"
import { createTools } from "../src/tools/index.ts"
import { loadLlmConfigFromEnv } from "../src/llm/index.ts"
import { createSubagentTool } from "../src/subagent/index.ts"
import { coderProfile, researcherProfile } from "../src/subagent/profiles.ts"
import type { Tool } from "../src/tools/types.ts"
import type { AgentMessage } from "../src/types.ts"

// ─── Config ─────────────────────────────────────────────────────────────────

interface BuildAgentOptions {
  /** Working directory (project root). Defaults to process.cwd() */
  cwd?: string
  /** LLM config. Defaults to env-configured model */
  llm?: LlmConfig
  /** Extra tools to add */
  extraTools?: Tool[]
  /** Override the default coding system prompt */
  systemPrompt?: string
  /** Max turns before giving up */
  maxTurns?: number
  /** Auto-spawn sub-agents for complex tasks (default: true) */
  autoSubagent?: boolean
}

// ─── System Prompt ────────────────────────────────────────────────────────────

const DEFAULT_SYSTEM_PROMPT = [
  "You are a coding assistant. Your job is to write, edit, and fix code.",
  "",
  "When given a task:",
  "1. Read existing files to understand the current code",
  "2. Make minimal, focused changes",
  "3. Follow existing code style and conventions",
  "4. Explain what you changed in a brief summary",
  "",
  "Rules:",
  "- Never delete code without replacing it",
  "- Keep changes small and atomic",
  "- If unsure, ask before making breaking changes",
  "- Use edit for modifications, write for new files",
].join("\n")

// ─── Main function ───────────────────────────────────────────────────────────

export async function buildAgent(
  input: string,
  options: BuildAgentOptions = {},
): Promise<{ text: string; turns: number; messages: AgentMessage[] }> {
  const {
    cwd = process.cwd(),
    llm,
    extraTools = [],
    systemPrompt = DEFAULT_SYSTEM_PROMPT,
    maxTurns = 20,
    autoSubagent = true,
  } = options

  const resolvedCwd = path.resolve(cwd)

  // Load LLM config from env (reads .env + profiles)
  const resolvedLlm = llm ?? loadLlmConfigFromEnv()

  // Build tools: coding tools + subagent support
  const baseTools = createTools(resolvedCwd, {
    codebase: true,
  })

  const subagentTool = createSubagentTool({
    parentLlm: resolvedLlm,
    parentTools: baseTools,
    profiles: [coderProfile, researcherProfile],
    maxDepth: 3,
  })

  const allTools = [...baseTools, subagentTool, ...extraTools]

  // Run the agent loop
  const messages = await runAgentLoop(input, {
    llm: resolvedLlm,
    tools: allTools,
    systemPrompt,
    maxTurns,
    autoSubagent: autoSubagent
      ? { enabled: true, minScore: 2, profile: "researcher" }
      : undefined,
  })

  // Extract result text
  const lastMsg = messages.at(-1)
  const text = extractText(lastMsg)

  // Count turns (assistant messages)
  const turnCount = messages.filter((m) => m.role === "assistant").length

  return {
    text,
    turns: turnCount,
    messages,
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractText(msg: AgentMessage | undefined): string {
  if (!msg || msg.role !== "assistant") return ""
  if (typeof msg.content === "string") return msg.content
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((p: any) => (p.type === "text" ? p.text : ""))
      .join("")
  }
  return ""
}

// ─── Multi-turn conversation helper ──────────────────────────────────────────

import { runAgentTurn } from "../src/loop.ts"

export async function buildAgentContinue(
  previousMessages: AgentMessage[],
  newUserInput: string,
  options: Omit<BuildAgentOptions, "cwd"> = {},
): Promise<{ text: string; turns: number }> {
  const { llm, maxTurns = 20 } = options
  const resolvedLlm = llm ?? loadLlmConfigFromEnv()

  const messages = await runAgentTurn(previousMessages, newUserInput, {
    llm: resolvedLlm,
    maxTurns,
  })

  const lastMsg = messages.at(-1)
  return {
    text: extractText(lastMsg),
    turns: messages.filter((m) => m.role === "assistant").length,
  }
}

// ─── Example usage ───────────────────────────────────────────────────────────

/*
import { buildAgent } from "./examples/build-agent.ts"

// Simple one-off task
const result = await buildAgent("create a README.md with project setup instructions")
console.log(result.text)
console.log(`Took ${result.turns} turns`)

// With explicit cwd
const result2 = await buildAgent("fix the login bug", { cwd: "/home/user/my-project" })

// Multi-turn
const first = await buildAgent("read the auth module and summarize it")
const second = await buildAgentContinue(first.messages, "now add JWT support")
*/

export default buildAgent
