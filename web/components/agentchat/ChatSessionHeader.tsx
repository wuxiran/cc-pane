// agent-chat 标签顶部的会话栏：引擎名 / 工作空间 chip / 生成中状态 / 本轮改动计数 / 工具卡全展开折叠 / 更多菜单。
// 从 AgentChatTabContent 拆出（行数棘轮），纯展示层：状态与动作全部经 props 注入。
import { type ReactNode } from "react";
import {
  Bot,
  ChevronsDownUp,
  ChevronsUpDown,
  ClipboardCopy,
  Copy,
  FileDiff,
  GitFork,
  Loader2,
  MoreHorizontal,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconTooltipButton } from "@/components/ui/IconTooltipButton";

export interface ChatSessionHeaderProps {
  engineLabel: string;
  /** 引擎名右侧的工作空间/目录 chip（StartProjectMenu trigger），由父组件注入。 */
  workspaceMenu?: ReactNode;
  generating: boolean;
  changesCount: number;
  showChanges: boolean;
  onToggleChanges: () => void;
  toolsExpanded: boolean;
  onToggleTools: () => void;
  canFork: boolean;
  onFork: () => void;
  canCopySessionId: boolean;
  onCopySessionId: () => void;
  canExport: boolean;
  onExport: () => void;
}

export default function ChatSessionHeader({
  engineLabel,
  workspaceMenu,
  generating,
  changesCount,
  showChanges,
  onToggleChanges,
  toolsExpanded,
  onToggleTools,
  canFork,
  onFork,
  canCopySessionId,
  onCopySessionId,
  canExport,
  onExport,
}: ChatSessionHeaderProps) {
  const { t } = useTranslation("panes");
  return (
    <div className="agent-chat-header flex min-h-12 shrink-0 items-center gap-3 px-5 py-2">
      <div className="agent-chat-header-identity flex min-w-0 items-center gap-2.5">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[var(--app-text-secondary)]">
          <Bot className="h-4 w-4" strokeWidth={1.6} />
        </span>
        <span className="truncate text-[13px] font-medium text-[var(--app-text-primary)]">{engineLabel}</span>
        {workspaceMenu ? (
          <div className="agent-chat-header-workspace min-w-0 max-w-[50%] [&>button]:max-w-full">
            {workspaceMenu}
          </div>
        ) : null}
        {generating ? (
          <span className="agent-chat-header-status flex shrink-0 items-center gap-1.5 text-xs text-[var(--app-text-tertiary)]">
            <Loader2 className="h-3 w-3 animate-spin" /> {t("agentChatThinking")}
          </span>
        ) : null}
      </div>
      <span className="flex-1" />
      {changesCount > 0 ? (
        <button
          type="button"
          aria-label={t("agentChatChanges")}
          className={`flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs tabular-nums transition-colors hover:bg-[var(--app-hover)] ${
            showChanges
              ? "bg-[var(--app-hover)] text-[var(--app-text-primary)]"
              : "text-[var(--app-text-secondary)] hover:text-[var(--app-text-primary)]"
          }`}
          onClick={onToggleChanges}
        >
          <FileDiff className="h-3.5 w-3.5" />
          {changesCount}
        </button>
      ) : null}
      <IconTooltipButton
        label={toolsExpanded ? t("agentChatCollapseTools") : t("agentChatExpandTools")}
        className="h-8 w-8"
        onClick={onToggleTools}
      >
        {toolsExpanded ? (
          <ChevronsDownUp className="h-3.5 w-3.5" />
        ) : (
          <ChevronsUpDown className="h-3.5 w-3.5" />
        )}
      </IconTooltipButton>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={t("agentChatMore")}
            className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--app-text-secondary)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)]"
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem disabled={!canFork} title={!canFork ? t("forkUnsupported") : undefined} onSelect={onFork}>
            <GitFork /> {t("forkChat")}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!canCopySessionId} onSelect={onCopySessionId}>
            <Copy /> {t("agentChatCopySessionId")}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!canExport} onSelect={onExport}>
            <ClipboardCopy /> {t("agentChatExportMarkdown")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
