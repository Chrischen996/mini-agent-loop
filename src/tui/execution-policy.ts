/** Read an opt-out boolean environment flag. Unset means enabled. */
export function isTuiFeatureEnabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized !== "0" && normalized !== "false" && normalized !== "off" && normalized !== "no";
}