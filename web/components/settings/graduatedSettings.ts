export type GraduatedSettingSource = "stable" | "experimental" | "default";

export interface GraduatedSettingInput<T> {
  stableValue?: T | null;
  experimentalValue?: T | null;
  defaultValue: T;
  defaultedForAllUsers?: boolean;
}

export interface GraduatedSettingHydration<T> {
  value: T;
  source: GraduatedSettingSource;
  needsPersistence: boolean;
  persisted: {
    stableValue: T;
    defaultedForAllUsers: true;
  };
}

/** Persistence adapters write `persisted` only when `needsPersistence` is true. */
export function hydrateGraduatedSetting<T>({
  stableValue,
  experimentalValue,
  defaultValue,
  defaultedForAllUsers = false,
}: GraduatedSettingInput<T>): GraduatedSettingHydration<T> {
  const value = stableValue ?? experimentalValue ?? defaultValue;
  const source: GraduatedSettingSource = stableValue != null
    ? "stable"
    : experimentalValue != null
      ? "experimental"
      : "default";

  return {
    value,
    source,
    needsPersistence: stableValue == null || !defaultedForAllUsers,
    persisted: { stableValue: value, defaultedForAllUsers: true },
  };
}
