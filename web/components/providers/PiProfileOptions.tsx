import type { Dispatch, SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { LaunchProfileDraft, PiLaunchOptions, PiProjectTrust } from "@/types";
import { Field } from "./launchProfileParts";
import { inputClass } from "./launchProfileHelpers";

interface PiProfileOptionsProps {
  draft: LaunchProfileDraft;
  setDraft: Dispatch<SetStateAction<LaunchProfileDraft>>;
}

function patchPiOptions(
  setDraft: Dispatch<SetStateAction<LaunchProfileDraft>>,
  patch: Partial<PiLaunchOptions>,
) {
  setDraft((current) => {
    const adapterOptions = { ...(current.adapterOptions ?? {}), ...patch };
    for (const key of ["piNativeProvider", "piNativeModel"] as const) {
      if (!adapterOptions[key]?.trim()) delete adapterOptions[key];
    }
    const usesNativePi = Boolean(adapterOptions.piNativeProvider || adapterOptions.piNativeModel);
    return {
      ...current,
      ...(usesNativePi ? { providerId: null, modelId: null } : {}),
      adapterOptions,
    };
  });
}

/** Pi-specific settings live in the shared launch-profile adapterOptions payload. */
export default function PiProfileOptions({ draft, setDraft }: PiProfileOptionsProps) {
  const { t } = useTranslation("providers");
  const projectTrust = draft.adapterOptions?.piProjectTrust ?? "inherit";

  return (
    <div className="mt-3 border-t border-[var(--app-border)]/60 pt-3">
      <div className="mb-2 text-[13px] font-medium" style={{ color: "var(--app-text-primary)" }}>
        {t("sectionPiTitle")}
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field label={t("fieldPiProjectTrust")}>
          <Select
            value={projectTrust}
            onValueChange={(value) => patchPiOptions(setDraft, { piProjectTrust: value as PiProjectTrust })}
          >
            <SelectTrigger aria-label={t("fieldPiProjectTrust")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="inherit">{t("piProjectTrust.inherit")}</SelectItem>
              <SelectItem value="approve">{t("piProjectTrust.approve")}</SelectItem>
              <SelectItem value="deny">{t("piProjectTrust.deny")}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>
      <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field label={t("fieldPiNativeProvider")}>
          <input
            className={inputClass}
            value={draft.adapterOptions?.piNativeProvider ?? ""}
            placeholder={t("piNativeProviderPlaceholder")}
            onChange={(event) => patchPiOptions(setDraft, { piNativeProvider: event.target.value })}
          />
        </Field>
        <Field label={t("fieldPiNativeModel")}>
          <input
            className={inputClass}
            value={draft.adapterOptions?.piNativeModel ?? ""}
            placeholder={t("piNativeModelPlaceholder")}
            onChange={(event) => patchPiOptions(setDraft, { piNativeModel: event.target.value })}
          />
        </Field>
      </div>
      <p className="mt-1.5 text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
        {t("piNativeAuthHint")}
      </p>
      <p className="mt-1 text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
        {t("piProjectTrustHint")}
      </p>
    </div>
  );
}
