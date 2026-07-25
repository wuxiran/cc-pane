interface OnboardingSettings {
  onboardingCompleted: boolean;
}

export function shouldOpenOnboarding(settings: OnboardingSettings | null): boolean {
  return settings?.onboardingCompleted === false;
}
