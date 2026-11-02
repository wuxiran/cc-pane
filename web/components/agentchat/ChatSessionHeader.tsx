// agent-chat 标签顶部的会话栏：引擎名 / 工作空间 chip / 生成中状态 / 本轮改动计数 / 工具卡全展开折叠 / 更多菜单。
// 从 AgentChatTabContent 拆出（行数棘轮），纯展示层：状态与动作全部经 props 注入。
import { useChatRuntimeTools } from "./ChatRuntimeWorkspace";
import { type ReactNode } from "react";
import {
  Bot,
  ChevronsDownUp,
  ChevronsUpDown,
  ClipboardCopy,
  Copy,
  FileDiff,
  GitFork,
  History,
  ListOrdered,
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
import { codexEngineLabel } from "@/lib/codexIntegration";

export interface ChatSessionHeaderProps {
  engineLabel: string;
  /** 引擎名右侧的工作空间/目录 chip（StartProjectMenu trigger），由父组件注入。 */
  workspaceMenu?: ReactNode;
  extraMenuItems?: ReactNode;
  generating: boolean;
  changesCount: number;
  showChanges: boolean;
  onToggleChanges: () => void;
  toolsExpanded: boolean;
  onToggleTools: () => void;
  canFork: boolean;
  onFork: () => void;
  onReviewFork?: () => void;
  onCheckpoints?: () => void;
  onHistory?: () => void;
  hasForkOrigin?: boolean;
  canCopySessionId: boolean;
  onCopySessionId: () => void;
  canExport: boolean;
  onExport: () => void;
}

export default function ChatSessionHeader({
  engineLabel,
  workspaceMenu,
  extraMenuItems,
  generating,
  changesCount,
  showChanges,
  onToggleChanges,
  toolsExpanded,
  onToggleTools,
  canFork,
  onFork,
  onReviewFork,
  onCheckpoints,
  onHistory,
  hasForkOrigin,
  canCopySessionId,
  onCopySessionId,
  canExport,
  onExport,
}: ChatSessionHeaderProps) {
  const { t } = useTranslation("panes");
  const { t: runtimeT } = useTranslation("agentRuntime");
  const { t: reviewT } = useTranslation("review");
  const runtimeTools = useChatRuntimeTools();
  return (
    <div className="agent-chat-header flex min-h-12 shrink-0 items-center gap-3 px-5 py-2">
      <div className="agent-chat-header-identity flex min-w-0 items-center gap-2.5">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[var(--app-text-secondary)]">
          <Bot className="h-4 w-4" strokeWidth={1.6} />
        </span>
        <span className="truncate text-[length:var(--text-row)] font-medium text-[var(--app-text-primary)]">{codexEngineLabel(engineLabel)}</span>
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
      {runtimeTools && <IconTooltipButton label={reviewT("title")} className="h-8 w-8" onClick={() => runtimeTools.openReview()}><FileDiff className="h-3.5 w-3.5" /></IconTooltipButton>}
      {onHistory && <IconTooltipButton label={runtimeT("title")} className="h-8 w-8" onClick={onHistory}><ListOrdered className="h-3.5 w-3.5" /></IconTooltipButton>}
      {onCheckpoints && <IconTooltipButton label={t("turnCheckpointTitle", { defaultValue: "Turn checkpoints" })} className="h-8 w-8" onClick={onCheckpoints}><History className="h-3.5 w-3.5" /></IconTooltipButton>}
      {hasForkOrigin && onReviewFork && <IconTooltipButton label={t("forkReviewTitle", { defaultValue: "Compare fork results" })} className="h-8 w-8" onClick={onReviewFork}><GitFork className="h-3.5 w-3.5" /></IconTooltipButton>}
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
          {extraMenuItems}
          <DropdownMenuItem disabled={!canFork} title={!canFork ? t("forkUnsupported") : undefined} onSelect={onFork}>
            <GitFork /> {t("forkChat")}
          </DropdownMenuItem>
          {onReviewFork && <DropdownMenuItem onSelect={onReviewFork}><FileDiff /> {t("forkReviewTitle", { defaultValue: "Compare fork results" })}</DropdownMenuItem>}
          {runtimeTools && <DropdownMenuItem onSelect={() => runtimeTools.openReview()}><FileDiff /> {reviewT("title")}</DropdownMenuItem>}
          {onHistory && <DropdownMenuItem onSelect={onHistory}><ListOrdered /> {runtimeT("title")}</DropdownMenuItem>}
          {onCheckpoints && <DropdownMenuItem onSelect={onCheckpoints}><History /> {t("turnCheckpointTitle", { defaultValue: "Turn checkpoints" })}</DropdownMenuItem>}
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
