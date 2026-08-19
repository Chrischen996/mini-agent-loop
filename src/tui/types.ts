import type { ModelRef } from "../models.ts";
import type { listProfiles } from "../profile-store.ts";

export type ModelSetupState = {
  model: ModelRef;
  baseUrl: string;
  apiKey: string;
  field: "baseUrl" | "apiKey";
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
