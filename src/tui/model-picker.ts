import { listProfiles, loadProfileStore } from "../profile-store.ts";
import type { ProfileSummary } from "./types.ts";

export type ModelPickerSection = "configured" | "catalog";

export async function loadConfiguredModelProfiles(): Promise<ProfileSummary[]> {
  try {
    const store = await loadProfileStore();
    return listProfiles(store).sort((left, right) =>
      Number(right.active) - Number(left.active) || left.name.localeCompare(right.name),
    );
  } catch {
    return [];
  }
}

export function filterConfiguredModelProfiles(
  profiles: readonly ProfileSummary[],
  query: string,
): ProfileSummary[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return [...profiles];
  return profiles.filter((profile) =>
    `${profile.name} ${profile.model} ${profile.baseUrl}`.toLocaleLowerCase().includes(normalizedQuery),
  );
}

export function configuredModelRowText(profile: ProfileSummary): string {
  return `${profile.active ? "✓ " : ""}${profile.name} (${profile.model}) · ${profile.baseUrl}`;
}
