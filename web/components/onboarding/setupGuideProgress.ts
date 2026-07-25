export const ONBOARDING_MULTI_LAUNCH_KEY = "cc-panes-onboarding-multi-launch";
export const ONBOARDING_PROGRESS_EVENT = "cc-panes:onboarding-progress";

export function notifySetupGuideProgress(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(ONBOARDING_PROGRESS_EVENT));
}
