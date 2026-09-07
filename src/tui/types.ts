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
