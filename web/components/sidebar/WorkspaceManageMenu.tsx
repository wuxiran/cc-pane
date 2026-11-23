// 工作空间右键菜单的后半段：配置（运行环境 / 技能 / 记忆 / MCP / Hooks）、打开位置、编辑。
// 原来这些平铺在菜单里（十几项），收成三个子菜单；从 WorkspaceItem 拆出也为了行数棘轮。
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Files, FolderOpen, PencilLine, SlidersHorizontal } from "lucide-react";
import { toast } from "@/components/ui/toast";
import {
  ContextMenuCheckboxItem,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { projectCliHooksService } from "@/services";
import { providerService } from "@/services/providerService";
import { isTauriRuntime } from "@/services/runtime";
import { useExplorerSectionsStore } from "@/stores";
import type { ProjectCliHookGroupStatus, ProjectCliHookStatus, Workspace } from "@/types";
import WorkspaceAppearanceMenu from "./WorkspaceAppearanceMenu";
import WorkspaceSkillsMenuItem from "./WorkspaceSkillsMenuItem";

interface WorkspaceManageMenuProps {
  workspace: Workspace;
  rootPath: string | undefined;
  /** 默认 / Agent Chat 这类系统工作空间：没有改名、别名、分组和默认上下文 */
  isSystem: boolean;
  onOpenEnvironment: (ws: Workspace) => void;
  onOpenInFileBrowser?: (path: string) => void;
  onSetPath: (ws: Workspace) => void;
  onClearPath: (ws: Workspace) => void;
  onSetAlias: (ws: Workspace) => void;
  onRename: (ws: Workspace) => void;
  onNewGroup: () => void;
}

export default function WorkspaceManageMenu({
  workspace, rootPath, isSystem, onOpenEnvironment, onOpenInFileBrowser,
  onSetPath, onClearPath, onSetAlias, onRename, onNewGroup,
}: WorkspaceManageMenuProps) {
  const { t } = useTranslation(["sidebar", "common"]);
  const preferredContextName = useExplorerSectionsStore((s) => s.preferredContextWorkspaceName);
  const setPreferredContext = useExplorerSectionsStore((s) => s.setPreferredContextWorkspace);
  // null = 还没加载；[] = 加载过但没有（不再一直显示「Loading...」）
  const [hookGroups, setHookGroups] = useState<ProjectCliHookGroupStatus[] | null>(null);

  const fetchHookStatuses = useCallback(async () => {
    if (!rootPath) return setHookGroups([]);
    try {
      setHookGroups(await projectCliHooksService.getStatus(rootPath));
    } catch {
      setHookGroups([]);
    }
  }, [rootPath]);

  const toggleHook = useCallback(async (cliTool: string, hook: ProjectCliHookStatus) => {
    if (!rootPath) return;
    try {
      await projectCliHooksService.setHookEnabled(rootPath, cliTool, hook.name, !hook.enabled);
      await fetchHookStatuses();
    } catch (error) {
      toast.error(t("hookOperationFailed", { error }));
    }
  }, [fetchHookStatuses, rootPath, t]);

  const revealFolder = useCallback(async () => {
    if (!rootPath) return;
    if (!isTauriRuntime()) {
      await navigator.clipboard.writeText(rootPath).catch(() => {});
      toast.info(t("filetree.pathCopied", { defaultValue: "Path copied" }));
      return;
    }
    try {
      await providerService.openPathInExplorer(rootPath);
    } catch (error) {
      toast.error(t("openFolderFailed", { error }));
    }
  }, [rootPath, t]);

  const hookLabel = (hook: Pick<ProjectCliHookStatus, "name" | "label">) =>
    ({ "session-inject": t("hookSessionInject"), "plan-archive": t("hookPlanArchive") } as Record<string, string>)[hook.name]
    || hook.label;

  return (
    <>
      <ContextMenuSub>
        <ContextMenuSubTrigger>
          <SlidersHorizontal /> {t("workspaceMenu.configure")}
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className="w-52">
          <ContextMenuItem onClick={() => onOpenEnvironment(workspace)}>
            {t("workspaceEnv.edit")}
          </ContextMenuItem>
          <WorkspaceSkillsMenuItem workspace={workspace} />
          {rootPath ? (
            <ContextMenuSub>
              <ContextMenuSubTrigger onPointerEnter={() => void fetchHookStatuses()}>
                {t("hooks")}
              </ContextMenuSubTrigger>
              <ContextMenuSubContent className="w-56">
                {hookGroups === null ? (
                  <ContextMenuItem disabled>{t("loading", { ns: "common" })}</ContextMenuItem>
                ) : hookGroups.length === 0 ? (
                  <ContextMenuItem disabled>{t("workspaceMenu.noHooks")}</ContextMenuItem>
                ) : hookGroups.map((group) => (
                  <ContextMenuSub key={group.cliTool}>
                    <ContextMenuSubTrigger>{group.label}</ContextMenuSubTrigger>
                    <ContextMenuSubContent className="w-56">
                      {group.hooks.map((hook) => (
                        <ContextMenuCheckboxItem
                          key={hook.name}
                          checked={hook.enabled}
                          disabled={!hook.supported}
                          onClick={() => hook.supported && void toggleHook(group.cliTool, hook)}
                        >
                          {hook.supported ? hookLabel(hook) : `${hookLabel(hook)} (${t("hookUnavailable")})`}
                        </ContextMenuCheckboxItem>
                      ))}
                      {group.reason ? (
                        <ContextMenuItem disabled>{t("hookUnavailableReason", { reason: group.reason })}</ContextMenuItem>
                      ) : null}
                    </ContextMenuSubContent>
                  </ContextMenuSub>
                ))}
              </ContextMenuSubContent>
            </ContextMenuSub>
          ) : null}
        </ContextMenuSubContent>
      </ContextMenuSub>

      {rootPath ? (
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <FolderOpen /> {t("workspaceMenu.openLocation")}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-52">
            <ContextMenuItem onClick={() => void revealFolder()}>
              <FolderOpen /> {t("openFolder")}
            </ContextMenuItem>
            {onOpenInFileBrowser ? (
              <ContextMenuItem onClick={() => onOpenInFileBrowser(rootPath)}>
                <Files /> {t("openInFileBrowser")}
              </ContextMenuItem>
            ) : null}
          </ContextMenuSubContent>
        </ContextMenuSub>
      ) : null}

      <ContextMenuSub>
        <ContextMenuSubTrigger>
          <PencilLine /> {t("workspaceMenu.edit")}
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className="w-56">
          {!isSystem ? (
            <>
              <ContextMenuItem onClick={() => onRename(workspace)}>{t("renameWorkspace")}</ContextMenuItem>
              <ContextMenuItem onClick={() => onSetAlias(workspace)}>{t("setAlias")}</ContextMenuItem>
            </>
          ) : null}
          <ContextMenuItem onClick={() => onSetPath(workspace)}>{t("setWorkspacePath")}</ContextMenuItem>
          {workspace.path ? (
            <ContextMenuItem onClick={() => onClearPath(workspace)}>{t("clearWorkspacePath")}</ContextMenuItem>
          ) : null}
          {!isSystem ? (
            <>
              <ContextMenuSeparator />
              <ContextMenuCheckboxItem
                checked={preferredContextName === workspace.name}
                onCheckedChange={(checked) => setPreferredContext(checked === true ? workspace.name : null)}
              >
                {t("workspaceSetDefaultContext")}
              </ContextMenuCheckboxItem>
              <ContextMenuSeparator />
              <WorkspaceAppearanceMenu workspace={workspace} onNewGroup={onNewGroup} />
            </>
          ) : null}
        </ContextMenuSubContent>
      </ContextMenuSub>
    </>
  );
}
