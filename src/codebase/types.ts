export type CodebaseEvidence = {
  provider: "git" | "deepwiki";
  repository: string;
  revision?: string;
  path?: string;
  startLine?: number;
  endLine?: number;
  content: string;
  generated: boolean;
};

export type CodebaseHandle = {
  handle: string;
  repository: string;
  revision: string;
  provider: "git";
};
