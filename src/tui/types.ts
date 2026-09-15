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
