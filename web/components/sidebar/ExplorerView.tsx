// Explorer 侧栏：EXPLORER 标题下三按钮 segmented（工作区 / 文件 / Git）单选切换，
// 同一时刻只显示选中的视图，占满高度自己滚动。工作空间树 keep-alive（display 翻转），
// 保证其挂载的 Dialogs 在切换视图时不丢失。
import { useTranslation } from "react-i18next";
import { Files, GitBranch, LayoutGrid, Rocket } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import WorkspaceTree from "@/components/sidebar/WorkspaceTree";
import {
  useDialogStore,
  useExplorerSectionsStore,
  useWorkspacesStore,
  type ExplorerSectionId,
} from "@/stores";
import ExplorerFilesSection from "./ExplorerFilesSection";
import ExplorerGitSection from "./ExplorerGitSection";
import type { OpenTerminalOptions } from "@/types";

// IDEA 风格图标 tab：图标 + tooltip，紧凑不占宽
const SECTIONS = [
  { id: "workspaces", labelKey: "explorer.tabWorkspaces", Icon: LayoutGrid },
  { id: "files", labelKey: "explorer.tabFiles", Icon: Files },
  { id: "git", labelKey: "explorer.tabGit", Icon: GitBranch },
] as const satisfies ReadonlyArray<{
  id: ExplorerSectionId;
  labelKey: string;
  Icon: typeof Files;
}>;

interface ExplorerViewProps {
  onOpenTerminal: (opts: OpenTerminalOptions) => void;
}

export default function ExplorerView({ onOpenTerminal }: ExplorerViewProps) {
  const { t } = useTranslation("sidebar");
  const activeSection = useExplorerSectionsStore((s) => s.activeSection);
  const setActiveSection = useExplorerSectionsStore((s) => s.setActiveSection);
  const workspace = useWorkspacesStore(
    (s) => s.workspaces.find((w) => w.id === s.expandedWorkspaceId) ?? null,
  );
  const expandedProjectId = useWorkspacesStore((s) => s.expandedProjectId);

  return (
    <div className="flex h-full flex-col">
      {/* 视图标题栏 + IDEA 风格图标 tab（同一行：左标题右图标组，节省纵向空间） */}
      <div className="flex shrink-0 items-center px-4 pt-3 pb-2">
        <span
          className="text-[10px] font-semibold uppercase tracking-[0.09em]"
          style={{ color: "var(--app-text-tertiary)" }}
        >
          EXPLORER
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={t("openLauncher", { ns: "launcher" })}
              onClick={() =>
                useDialogStore.getState().openLauncher(
                  workspace ? { workspaceName: workspace.name } : undefined,
                )
              }
              className="ml-2 flex h-[26px] w-[28px] items-center justify-center rounded-md transition-colors duration-[var(--dur-fast)] hover:bg-[var(--app-hover)]"
              style={{ color: "var(--app-text-secondary)" }}
            >
              <Rocket className="h-[15px] w-[15px]" strokeWidth={1.8} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t("openLauncher", { ns: "launcher" })}</TooltipContent>
        </Tooltip>
        <div
          className="ml-auto flex items-center gap-0.5"
          role="tablist"
          aria-label="EXPLORER"
        >
          {SECTIONS.map(({ id, labelKey, Icon }) => {
            const selected = id === activeSection;
            return (
              <Tooltip key={id}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    aria-label={t(labelKey)}
                    onClick={() => setActiveSection(id)}
                    className={`flex h-[26px] w-[28px] items-center justify-center rounded-md transition-colors duration-[var(--dur-fast)] ${
                      selected ? "" : "hover:bg-[var(--app-hover)]"
                    }`}
                    style={
                      selected
                        ? {
                            background: "color-mix(in srgb, var(--app-accent) 12%, transparent)",
                            color: "var(--app-accent)",
                          }
                        : { color: "var(--app-text-secondary)" }
                    }
                  >
                    <Icon className="h-[15px] w-[15px]" strokeWidth={1.8} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{t(labelKey)}</TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      </div>

      {/* 工作空间视图：keep-alive，隐藏而不卸载（WorkspaceDialogs 挂在树内） */}
      <div
        className="min-h-0 flex-1 overflow-y-auto px-3 pb-2"
        style={activeSection === "workspaces" ? undefined : { display: "none" }}
      >
        <WorkspaceTree onOpenTerminal={onOpenTerminal} />
      </div>

      {activeSection === "files" && (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          <ExplorerFilesSection workspace={workspace} selectedProjectId={expandedProjectId} />
        </div>
      )}

      {activeSection === "git" && (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          <ExplorerGitSection workspace={workspace} selectedProjectId={expandedProjectId} />
        </div>
      )}
    </div>
  );
}
