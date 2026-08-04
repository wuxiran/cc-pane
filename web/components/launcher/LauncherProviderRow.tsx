// Provider 选择：inherit（跟随工作空间/项目绑定）/ explicit（显式选 Provider）/ none +
// Launch Profile 下拉（空 = 跟随绑定/默认，由后端解析）。
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useLaunchProfilesStore, useProvidersStore } from "@/stores";
import { useCliTools } from "@/hooks/useCliTools";
import type { LaunchProviderSelection } from "@/types";
import { isProviderTypeCompatibleWithCli } from "@/utils/providerCompatibility";
import type { LauncherDraft } from "./launcherModel";

const SELECTIONS: LaunchProviderSelection[] = ["inherit", "explicit", "none"];

interface LauncherProviderRowProps {
  draft: LauncherDraft;
  onChange: (patch: Partial<LauncherDraft>) => void;
}

export default function LauncherProviderRow({ draft, onChange }: LauncherProviderRowProps) {
  const { t } = useTranslation("launcher");
  const providers = useProvidersStore((s) => s.providers);
  const loadProviders = useProvidersStore((s) => s.loadProviders);
  const profiles = useLaunchProfilesStore((s) => s.profiles);
  const loadProfiles = useLaunchProfilesStore((s) => s.load);
  const { tools } = useCliTools();

  useEffect(() => {
    if (providers.length === 0) loadProviders().catch(() => undefined);
    if (profiles.length === 0) loadProfiles().catch(() => undefined);
    // 仅初始化拉一次；空列表本身也是合法状态，失败静默（下拉保持空）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 只列匹配当前 CLI 的 profile（targetTools 为空 = 通用）
  const matchingProfiles = profiles.filter(
    (profile) =>
      profile.targetTools.length === 0
      || draft.cliTool === "none"
      || profile.targetTools.includes(draft.cliTool),
  );
  const compatibleProviders = providers.filter((provider) =>
    isProviderTypeCompatibleWithCli(provider.providerType, draft.cliTool, tools));

  useEffect(() => {
    if (
      draft.providerSelection === "explicit"
      && draft.providerId
      && tools.length > 0
      && !compatibleProviders.some((provider) => provider.id === draft.providerId)
    ) {
      onChange({ providerId: undefined });
    }
  }, [compatibleProviders, draft.providerId, draft.providerSelection, onChange, tools.length]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {draft.cliTool !== "none" && <select
        className="h-8 rounded-md border bg-background px-2 text-xs"
        value={draft.providerSelection}
        onChange={(event) => {
          const selection = event.target.value as LaunchProviderSelection;
          onChange({
            providerSelection: selection,
            providerId: selection === "explicit" ? draft.providerId : undefined,
          });
        }}
        aria-label={t("providerMode")}
      >
        {SELECTIONS.map((selection) => (
          <option key={selection} value={selection}>
            {t(`providerSelection.${selection}`)}
          </option>
        ))}
      </select>}

      {draft.cliTool !== "none" && draft.providerSelection === "explicit" && (
        <select
          className="h-8 min-w-[140px] rounded-md border bg-background px-2 text-xs"
          value={draft.providerId ?? ""}
          onChange={(event) => onChange({ providerId: event.target.value || undefined })}
          aria-label={t("provider")}
        >
          <option value="">{t("providerPlaceholder")}</option>
          {compatibleProviders.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.name} ({provider.providerType})
            </option>
          ))}
        </select>
      )}

      {draft.cliTool !== "none"
        && draft.providerSelection === "explicit"
        && compatibleProviders.length === 0 && (
          <span className="text-xs" style={{ color: "var(--app-text-tertiary)" }}>
            {t("providerNoneCompatible")}
          </span>
        )}

      <select
        className="h-8 min-w-[140px] rounded-md border bg-background px-2 text-xs"
        value={draft.launchProfileId ?? ""}
        onChange={(event) => onChange({ launchProfileId: event.target.value || undefined })}
        aria-label={t("launchProfile")}
      >
        <option value="">{t("launchProfileInherit")}</option>
        {matchingProfiles.map((profile) => (
          <option key={profile.id} value={profile.id}>
            {profile.alias || profile.name}
          </option>
        ))}
      </select>
    </div>
  );
}
