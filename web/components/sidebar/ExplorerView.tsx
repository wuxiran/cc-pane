// Explorer 侧栏：「空间 | 任务」等宽切换（行首）+ 搜索按钮（行尾）。
// 工作空间模式：上面是工作空间树，下面是「最近」的会话。
// 任务模式：不显示工作空间，跨工作空间按「轮到谁动」排运行中的任务（TaskBoardView）。
// 两个模式都 keep-alive（树里挂着 WorkspaceDialogs，卸载会丢对话框状态）。
// 会话（CLI 启动记录 + Agent 对话）收进搜索面板（Ctrl+K），通讯录移到最左侧图标栏，
// 「启动终端」是搜索面板里的快捷操作（也可以用快捷键或标签栏的 +）。
// 文件 / Git 视图在右侧 RightDock（跟随激活终端、多根），左侧不重复入口。
import { useTranslation } from "react-i18next";
import { Search } from "lucide-react";
import { useRowTypeAhead } from "@/hooks/useTypeAhead";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import WorkspaceTree from "@/components/sidebar/WorkspaceTree";
import RecentSessionsSection from "@/components/sidebar/RecentSessionsSection";
import TaskBoardView from "@/components/sidebar/TaskBoardView";
import { SegmentedTabs } from "@/components/ui/segmented";
import { useExplorerSectionsStore, type ExplorerMode } from "@/stores/useExplorerSectionsStore";
import { toggleCommandPalette } from "@/lib/commands/paletteEvents";
import { formatKeyCombo, useSettingsStore } from "@/stores";
import type { OpenTerminalOptions } from "@/types";

interface ExplorerViewProps {
  onOpenTerminal: (opts: OpenTerminalOptions) => void;
}

export default function ExplorerView({ onOpenTerminal }: ExplorerViewProps) {
  const { t } = useTranslation("sidebar");
  const onTreeTypeAhead = useRowTypeAhead();
  const paletteBinding = useSettingsStore((s) => s.settings?.shortcuts.bindings["command-palette"]);
  const searchLabel = t("explorer.search");
  const mode = useExplorerSectionsStore((s) => s.explorerMode);
  const setMode = useExplorerSectionsStore((s) => s.setExplorerMode);
  const tasks = mode === "tasks";

  return (
    <section aria-label={t("explorer.title")} className="flex h-full flex-col">
      <div className="flex shrink-0 items-center px-4 pt-3 pb-2">
        {/* 不再显示「资源管理器」标题：切换器顶到行首，两档等宽；标题留作区域的无障碍名 */}
        <SegmentedTabs<ExplorerMode>
          size="sm"
          className="grid grid-cols-2"
          aria-label={t("explorer.modeSwitch")}
          value={mode}
          onValueChange={setMode}
          items={[
            { value: "workspaces", label: t("explorer.modeWorkspaces") },
            { value: "tasks", label: t("explorer.modeTasks") },
          ]}
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={searchLabel}
              data-testid="explorer-search"
              onClick={toggleCommandPalette}
              className="ml-auto flex h-[26px] w-[28px] items-center justify-center rounded-md text-[var(--app-text-secondary)] transition-colors duration-[var(--dur-fast)] hover:bg-[var(--app-hover)]"
            >
              <Search className="h-[15px] w-[15px]" strokeWidth={1.8} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {searchLabel}{paletteBinding ? ` (${formatKeyCombo(paletteBinding)})` : ""}
          </TooltipContent>
        </Tooltip>
      </div>

      {/* 树按内容高度排，放不下才收缩滚动；「最近」紧跟在它下面，不再被顶到面板最底部 */}
      <div
        className="app-scrollbar min-h-0 shrink overflow-y-auto px-3 pb-2"
        onKeyDown={onTreeTypeAhead}
        style={tasks ? { display: "none" } : undefined}
      >
        <WorkspaceTree onOpenTerminal={onOpenTerminal} />
      </div>

      {/* 下半部分：最近的会话（点一下恢复，悬浮看详情） */}
      {/* display:contents —— 可见时不引入额外盒子，分区自己的 flex-1/shrink-0 布局原样生效 */}
      <div style={{ display: tasks ? "none" : "contents" }}>
        <RecentSessionsSection onOpenTerminal={onOpenTerminal} />
      </div>

      {/* 任务模式：非激活时不订阅 panes/status */}
      <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto" style={tasks ? undefined : { display: "none" }}>
        <TaskBoardView active={tasks} />
      </div>
    </section>
  );
}
