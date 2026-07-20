import type { RepositoryStore } from "./repository-store.ts";
import type { CodebaseEvidence } from "./types.ts";
import { DeepWikiClient, type DeepWikiToolName } from "./deepwiki-client.ts";

export type CodebaseExplainOperation = "structure" | "contents" | "question";

export type CodebaseSemanticProvider = {
  explain(
    handle: string,
    operation: CodebaseExplainOperation,
    question?: string,
    signal?: AbortSignal,
  ): Promise<CodebaseEvidence>;
  close(): Promise<void>;
};

const TOOL_BY_OPERATION: Record<CodebaseExplainOperation, DeepWikiToolName> = {
  structure: "read_wiki_structure",
  contents: "read_wiki_contents",
  question: "ask_question",
};

export class DeepWikiProvider implements CodebaseSemanticProvider {
  constructor(
    private readonly store: RepositoryStore,
    private readonly client: DeepWikiClient,
  ) {}

  async explain(
    handleId: string,
    operation: CodebaseExplainOperation,
    question?: string,
    signal?: AbortSignal,
  ): Promise<CodebaseEvidence> {
    const handle = this.store.get(handleId);
    if (!(operation in TOOL_BY_OPERATION)) throw new Error(`Unknown DeepWiki operation: ${operation}`);
    const normalizedQuestion = question?.trim();
    if (operation === "question" && !normalizedQuestion) {
      throw new Error("question is required for the question operation");
    }
    const args = operation === "question"
      ? { repoName: handle.repository, question: normalizedQuestion }
      : { repoName: handle.repository };
    const content = await this.client.call(TOOL_BY_OPERATION[operation], args, signal);
    return {
      provider: "deepwiki",
      repository: handle.repository,
      content,
      generated: true,
    };
  }

  close(): Promise<void> {
    return this.client.close();
  }
}
