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
export type MultiAgentSetupState = {
  /** Which step the wizard is on */
  step: "model" | "mode" | "task";
  /** Selected orchestrator model id (e.g. "deepseek/deepseek-v4-flash") */
  orchestratorModel?: string;
  /** Selected job kind */
  mode?: "planner_worker_reviewer" | "agent_turn";
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
};
