// 运行配置页按工作空间查看时，紧挨「当前绑定的运行配置」给出工作空间默认账号绑定。
// 只在工作空间绑了供应商、且该供应商有多个账号时出现；不按 CLI 过滤（工作空间绑定不限 CLI）。
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toastErr, toastOk } from "@/lib/feedback";
import { useProvidersStore, useWorkspacesStore } from "@/stores";
import type { Workspace } from "@/types/workspace";
import { selectableAccounts } from "@/utils/providerAccounts";
import LauncherAccountSelect from "@/components/launcher/LauncherAccountSelect";

export default function LaunchProfileWorkspaceAccountRow({ workspace }: { workspace: Workspace }) {
  const { t } = useTranslation("launcher");
  const providers = useProvidersStore((s) => s.providers);
  const updateAccount = useWorkspacesStore((s) => s.updateWorkspaceProviderAccount);
  const [saving, setSaving] = useState(false);
  const provider = workspace.providerId
    ? providers.find((item) => item.id === workspace.providerId)
    : undefined;
  if (!provider || selectableAccounts(provider).length <= 1) return null;

  const handleChange = async (accountId: string | undefined) => {
    setSaving(true);
    try {
      await updateAccount(workspace.name, accountId ?? null);
      toastOk(t("account.workspaceSaved"));
    } catch (error) {
      toastErr(t("account.workspaceSaveFailed", { error: String(error) }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2" data-testid="workspace-account-row">
      <span style={{ color: "var(--app-text-secondary)" }}>{t("account.workspaceDefault")}</span>
      <LauncherAccountSelect
        provider={provider}
        value={workspace.providerAccountId}
        disabled={saving}
        ariaLabel={t("account.workspaceDefault")}
        onChange={(accountId) => { void handleChange(accountId); }}
      />
      <span>{t("account.workspaceProviderHint", { provider: provider.name })}</span>
    </div>
  );
}
