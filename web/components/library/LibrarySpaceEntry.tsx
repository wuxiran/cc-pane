// 资料空间（docs/108）入口：没有就弹窗创建（路径可改），有就直接拉起素材助手会话。
// 资料空间的业务逻辑全在模板的 CLAUDE.md / skills 里，这里只负责“建好目录 + 开一个 Claude Code”。
// 启动走 pendingLaunch，由 App 级唯一的 useOpenTerminal 消费——不要在这里挂 useOpenTerminal。
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { FolderOpen } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toastErr, toastOk, toastWarn } from "@/lib/feedback";
import { createLibrarySpace } from "@/services/librarySpaceService";
import { useActivityBarStore } from "@/stores/useActivityBarStore";
import { useDialogStore } from "@/stores/useDialogStore";
import { useWorkspacesStore } from "@/stores/useWorkspacesStore";
import { isTauriRuntime } from "@/utils";

/** 工作空间名按创建时的界面语言落盘；切换语言后两个名字都要认。 */
const LIBRARY_NAME_LOCALES = ["zh-CN", "en"];

export interface LibrarySpaceEntry {
  /** 非桌面运行时（Web 远程访问）不提供入口。 */
  available: boolean;
  label: string;
  open: () => void;
  /** 创建弹窗，调用方渲染到任意位置。 */
  dialog: ReactNode;
}

export function useLibrarySpaceEntry(): LibrarySpaceEntry {
  const { t } = useTranslation("sidebar");
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const reloadWorkspaces = useWorkspacesStore((s) => s.load);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);

  const workspaceName = t("librarySpace.workspaceName");
  const knownNames = new Set(LIBRARY_NAME_LOCALES.map((lng) => t("librarySpace.workspaceName", { lng })));
  const existing = workspaces.find((ws) => knownNames.has(ws.name) && ws.projects.length > 0);

  const launchAssistant = (root: string, name: string) => {
    useActivityBarStore.getState().setAppViewMode("panes");
    useDialogStore.getState().setPendingLaunch({
      path: root,
      workspaceName: name,
      workspacePath: root,
      providerId: "",
      providerSelection: "inherit",
      cliTool: "claude",
      appendSystemPrompt: t("librarySpace.assistantPrompt"),
    });
  };

  const openEntry = () => {
    if (existing) {
      launchAssistant(existing.projects[0].path, existing.name);
      return;
    }
    setPath("");
    setDialogOpen(true);
  };

  const handleBrowse = async () => {
    try {
      const selected = await open({ directory: true, multiple: false, title: t("librarySpace.chooseFolder") });
      if (typeof selected === "string") setPath(selected);
    } catch (error) {
      toastErr(String(error));
    }
  };

  const handleCreate = async () => {
    setBusy(true);
    try {
      const space = await createLibrarySpace(workspaceName, path.trim() || null);
      await reloadWorkspaces();
      setDialogOpen(false);
      if (space.scaffold.kept.includes("CLAUDE.md")) {
        toastWarn(t("librarySpace.keptClaudeMd"));
      } else {
        toastOk(t("librarySpace.created", { path: space.root }));
      }
      launchAssistant(space.root, space.workspaceName);
    } catch (error) {
      toastErr(t("librarySpace.createFailed", { error: String(error) }));
    } finally {
      setBusy(false);
    }
  };

  const dialog = (
    <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("librarySpace.create")}</DialogTitle>
          <DialogDescription>{t("librarySpace.description")}</DialogDescription>
        </DialogHeader>
        <div className="flex gap-2 py-2">
          <Input value={path} readOnly placeholder="~/CC-Panes-Library" className="flex-1" />
          <Button variant="secondary" onClick={handleBrowse}>
            <FolderOpen size={14} className="mr-1" /> {t("librarySpace.browse")}
          </Button>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => setDialogOpen(false)}>
            {t("cancel", { ns: "common" })}
          </Button>
          <Button onClick={handleCreate} disabled={busy}>
            {t("librarySpace.createAndOpen")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return {
    available: isTauriRuntime(),
    label: existing ? t("librarySpace.openAssistant") : t("librarySpace.create"),
    open: openEntry,
    dialog,
  };
}
