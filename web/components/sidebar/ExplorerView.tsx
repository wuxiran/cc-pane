// Explorer 侧栏：标题 + 搜索按钮，上面是工作空间树，下面是「最近」的会话。
// 会话（CLI 启动记录 + Agent 对话）收进搜索面板（Ctrl+K），通讯录移到最左侧图标栏，
// 「启动终端」是搜索面板里的快捷操作（也可以用快捷键或标签栏的 +）。
// 文件 / Git 视图在右侧 RightDock（跟随激活终端、多根），左侧不重复入口。
import { useTranslation } from "react-i18next";
import { Search } from "lucide-react";
import { useRowTypeAhead } from "@/hooks/useTypeAhead";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import WorkspaceTree from "@/components/sidebar/WorkspaceTree";
import RecentSessionsSection from "@/components/sidebar/RecentSessionsSection";
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

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center px-4 pt-3 pb-2">
        <span className="text-[length:var(--text-caption)] font-semibold text-[var(--app-text-tertiary)]">{t("explorer.title")}</span>
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

      <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto px-3 pb-2" onKeyDown={onTreeTypeAhead}>
        <WorkspaceTree onOpenTerminal={onOpenTerminal} />
      </div>

      {/* 下半部分：最近的会话（点一下恢复，悬浮看详情） */}
      <RecentSessionsSection onOpenTerminal={onOpenTerminal} />
    </div>
  );
}
