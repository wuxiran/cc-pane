// 默认工作目录：没选项目时，新开的会话落在这里。
// 它背后是系统自带的默认工作空间——不在侧边栏列表里露出，位置按约定放在数据目录下，
// 只有想换地方时才需要来这里改。
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { open as openDirectoryDialog } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import { toastErr, toastOk } from "@/lib/feedback";
import { useWorkspacesStore } from "@/stores";
import { getErrorMessage } from "@/utils";
import { SettingsRow, SettingsValue } from "./layout";

export default function DefaultWorkspaceDirSetting() {
  const { t } = useTranslation(["settings", "common"]);
  const workspace = useWorkspacesStore((s) => s.workspaces.find((ws) => ws.isDefault) ?? null);
  const updateWorkspacePath = useWorkspacesStore((s) => s.updateWorkspacePath);
  const [busy, setBusy] = useState(false);
  if (!workspace) return null;

  const browse = async () => {
    try {
      const selected = await openDirectoryDialog({ directory: true, multiple: false, title: t("defaultWorkspaceDirPick") });
      if (!selected || String(selected) === workspace.path) return;
      setBusy(true);
      await updateWorkspacePath(workspace.name, String(selected));
      toastOk(t("defaultWorkspaceDirChanged"));
    } catch (error) {
      toastErr(t("defaultWorkspaceDirFailed", { error: getErrorMessage(error) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsRow
      data-testid="default-workspace-dir"
      title={t("defaultWorkspaceDir")}
      description={t("defaultWorkspaceDirDesc")}
      control={(
        <Button variant="secondary" size="sm" onClick={() => void browse()} disabled={busy}>
          {t("browse", { ns: "common" })}
        </Button>
      )}
    >
      <SettingsValue title={workspace.path}>
        {workspace.path || t("defaultWorkspaceDirUnset")}
      </SettingsValue>
    </SettingsRow>
  );
}
