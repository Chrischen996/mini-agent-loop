import type { ModelRef } from "../models.ts";
import type { listProfiles } from "../profile-store.ts";

export type ModelSetupState = {
  model: ModelRef;
  baseUrl: string;
  apiKey: string;
  field: "baseUrl" | "apiKey";
  error?: string;
};

export type ProfileListState = {
  profiles: ReturnType<typeof listProfiles>;
  selectedIndex: number;
};
