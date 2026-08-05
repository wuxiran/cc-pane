import type { LaunchProfile, LaunchProviderSelection, Provider } from "@/types";

export interface ContextModelSelection {
  providerId: string | null;
  modelId: string | null;
  providerSelection: LaunchProviderSelection | null;
  launchProfileId: string | null;
}

function normalize(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

export function normalizeContextPercentage(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  if (!Number.isInteger(value) || value < 0 || value > 100) return null;
  return value;
}

/** Prefer the model selected for this launch over a proxy-reported response model. */
export function resolveContextDisplayModel(
  selection: ContextModelSelection,
  reportedModel: string | null,
  profiles: LaunchProfile[],
  providers: Provider[],
): string | null {
  const reported = normalize(reportedModel);
  if (selection.providerSelection === "none") return reported;

  const profileId = normalize(selection.launchProfileId);
  const profile = profileId
    ? profiles.find((item) => item.id === profileId)
    : undefined;
  const requestedProviderId = normalize(selection.providerId);
  const profileProviderId = normalize(profile?.providerId);
  const effectiveProviderId = requestedProviderId ?? profileProviderId;
  const provider = effectiveProviderId
    ? providers.find((item) => item.id === effectiveProviderId)
    : undefined;

  const requestedModelId = normalize(selection.modelId);
  const profileModelId = !requestedProviderId && profileProviderId
    ? normalize(profile?.modelId)
    : null;
  const configuredModelId = requestedModelId
    ?? profileModelId
    ?? normalize(provider?.defaultModelId);
  if (!configuredModelId) return reported;

  const configuredModel = provider?.models?.find((item) => item.id === configuredModelId);
  return normalize(configuredModel?.label) ?? configuredModelId;
}
