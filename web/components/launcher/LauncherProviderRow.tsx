// Provider 选择：inherit（跟随工作空间/项目绑定）/ explicit（显式选 Provider）/ none +
// Launch Profile 下拉（空 = 跟随绑定/默认，由后端解析）。
// 显式选了供应商且它在当前 CLI 下有多个可选账号时，再出现账号选择；换供应商 / 换模式清掉账号。
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useLaunchProfilesStore, useProvidersStore } from "@/stores";
import { useCliTools } from "@/hooks/useCliTools";
import type { LaunchProviderSelection } from "@/types";
import { isProviderTypeCompatibleWithCli } from "@/utils/providerCompatibility";
import type { LauncherDraft } from "./launcherModel";
import LauncherAccountSelect from "./LauncherAccountSelect";
import { effectiveLaunchAccountId } from "./launcherAccounts";

const SELECTIONS: LaunchProviderSelection[] = ["inherit", "explicit", "none"];

interface LauncherProviderRowProps {
  draft: LauncherDraft;
  onChange: (patch: Partial<LauncherDraft>) => void;
  /** 运行时是 WSL / SSH：本机登录账号不可选。 */
  remote?: boolean;
}

export default function LauncherProviderRow({ draft, onChange, remote = false }: LauncherProviderRowProps) {
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

  const selectedProvider = compatibleProviders.find((provider) => provider.id === draft.providerId);

  // 记住的账号失效（被删 / 换了 CLI 不再可选 / 换到远端运行时而它是本机登录账号）就退回默认账号。
  useEffect(() => {
    if (!draft.providerAccountId || !selectedProvider) return;
    if (!effectiveLaunchAccountId(selectedProvider, draft.cliTool, draft.providerAccountId, remote)) {
      onChange({ providerAccountId: undefined });
    }
  }, [draft.cliTool, draft.providerAccountId, onChange, remote, selectedProvider]);

  useEffect(() => {
    if (
      draft.providerSelection === "explicit"
      && draft.providerId
      && tools.length > 0
      && !compatibleProviders.some((provider) => provider.id === draft.providerId)
    ) {
      onChange({ providerId: undefined, providerAccountId: undefined });
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
            providerAccountId: selection === "explicit" ? draft.providerAccountId : undefined,
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
          onChange={(event) => onChange({ providerId: event.target.value || undefined, providerAccountId: undefined })}
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

      {draft.cliTool !== "none" && draft.providerSelection === "explicit" && selectedProvider && (
        <LauncherAccountSelect
          provider={selectedProvider}
          cliTool={draft.cliTool}
          value={draft.providerAccountId}
          remote={remote}
          onChange={(providerAccountId) => onChange({ providerAccountId })}
        />
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
