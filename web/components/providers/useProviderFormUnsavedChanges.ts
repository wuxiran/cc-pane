import { useCallback, useEffect } from "react";
import { useUnsavedChangesGuard } from "@/hooks/useUnsavedChangesGuard";
import { buildConfigJson, parseConfigJson, type FormState } from "./providerFormState";
import type { ProviderType } from "@/types/provider";

interface UseProviderFormUnsavedChangesArgs {
  form: FormState;
  initialForm: FormState;
  providerType: ProviderType;
  configJson: string;
  configFileContent: string;
  configFileOriginal: string;
  onBack: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}

export function useProviderFormUnsavedChanges({
  form,
  initialForm,
  providerType,
  configJson,
  configFileContent,
  configFileOriginal,
  onBack,
  onDirtyChange,
}: UseProviderFormUnsavedChangesArgs) {
  const formIsDirty = JSON.stringify(form) !== JSON.stringify(initialForm);
  const configFileIsDirty = configFileContent !== configFileOriginal;
  const invalidConfigJsonIsDirty = providerType !== "config_profile"
    && parseConfigJson(configJson, providerType) === null
    && configJson !== buildConfigJson(initialForm);
  const isDirty = formIsDirty || configFileIsDirty || invalidConfigJsonIsDirty;
  const discardGuard = useUnsavedChangesGuard(isDirty, () => onDirtyChange?.(false));

  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const requestBack = useCallback(() => discardGuard.request(onBack), [discardGuard.request, onBack]);
  return { configFileIsDirty, discardGuard, requestBack };
}
