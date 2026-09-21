import type { LlmGatewayProtocol, ModelRef } from "../models.ts";
import type { listProfiles } from "../profile-store.ts";

export type ModelSetupState = {
  model: ModelRef;
  baseUrl: string;
  apiKey: string;
  field: "baseUrl" | "apiKey";
  /** Preserve `/model --protocol` across the Base URL / API key overlay. */
  protocol?: LlmGatewayProtocol;
  error?: string;
};

export type PendingProfileSetup = {
  model: ModelRef;
  baseUrl: string;
  apiKey: string;
};

export type ProfileSummary = ReturnType<typeof listProfiles>[number];

export type ProfileListState = {
  profiles: ProfileSummary[];
  selectedIndex: number;
};

/**
 * State for the /multi-agent interactive setup wizard.
 * Advances through steps: model selection → mode selection → task input.
 */
export type MultiAgentRoleName = "researcher" | "coder" | "reviewer";

export type MultiAgentRoleAssignment =
  | { type: "inherit" }
  | { type: "profile"; profileName: string }
  | {
      type: "draft-new";
      modelId: string;
      baseUrl?: string;
      apiKey?: string;
      field?: "modelId" | "baseUrl" | "apiKey";
      error?: string;
    };

export type MultiAgentSetupState = {
  /** Which step the wizard is on */
  step: "model" | "mode" | "roles" | "role-new" | "task";
  /** Selected orchestrator model id (e.g. "deepseek/deepseek-v4-flash") */
  orchestratorModel?: string;
  /**
   * Selected job kind:
   * - `planner_worker_reviewer` — exposes the `multi_agent_pipeline` tool to
   *   the LLM, which decides whether/how to drive the H3+H4 pipeline.
   * - `agent_turn` — a single agent turn with subagent delegation.
   * - `planner_worker_reviewer_forced` — 100%-deterministic code path: the
   *   H3+H4 pipeline is invoked directly in code (no LLM decision) and its
   *   structured outcome is appended to the conversation.
   */
  mode?: "planner_worker_reviewer" | "agent_turn" | "planner_worker_reviewer_forced";
  /** Sub-role configurations (step C) */
  roleAssignments?: Record<MultiAgentRoleName, MultiAgentRoleAssignment>;
  /** Index of role being edited when step === "roles" */
  roleIndex?: number;
  /** Task description collected in the final step */
  task?: string;
};

/**
 * State for the post-model-switch subagent role assignment wizard.
 * Steps through each built-in role: researcher → coder → reviewer.
 * User picks a profile name (from saved profiles) for each role, or skips.
 */
export type RoleSetupState = {
  /** The three built-in roles, in order */
  roles: Array<"researcher" | "coder" | "reviewer">;
  /** Which role we are currently assigning (index into roles[]) */
  currentRoleIndex: number;
  /** All saved profile names the user can pick from */
  profileNames: string[];
  /** Currently highlighted index in profileNames list */
  selectedIndex: number;
  /** Bindings chosen so far: role → profileName */
  chosen: Partial<Record<"researcher" | "coder" | "reviewer", string>>;
  /**
   * When set, the user chose "new model" for the role at this index. The main
   * model-setup wizard is opened to collect `baseUrl` / `apiKey`; on submit the
   * new profile is saved and bound to this role, then the wizard resumes.
   */
  pendingNewModelRoleIndex?: number;
};
