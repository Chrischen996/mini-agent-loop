export type ModelHint = "light" | "standard" | "flagship";

export interface TaskSpec {
  id: string;
  title: string;
  context: string;
  instruction: string;
  acceptance: string[];
  files_hint: string[];
  depends_on?: string[];
  model_hint?: ModelHint;
}

export interface WorkerResult {
  id: string;
  status: "done" | "blocked" | "failed";
  message: string;
  changed_files: string[];
  summary: string;
  test_result?: string;
  notes?: string;
  attempt?: number;
  nonce?: string;
  error?: string;
  branch?: string;
}

export interface ReviewVerdict {
  passed: boolean;
  failed_items: string[];
  suggestions?: string;
}

export type PipelineEventName =
  | "dispatch"
  | "start"
  | "tool_call"
  | "result"
  | "done"
  | "fail"
  | "retry"
  | "callback"
  | "review_pass"
  | "review_fail"
  | "merge"
  | "rollback"
  | "split";

export interface PipelineLogEvent {
  ts: string;
  task_id: string;
  event: PipelineEventName;
  attempt?: number;
  [key: string]: unknown;
}

export type TaskStatus = "pending" | "running" | "done" | "failed" | "blocked";
