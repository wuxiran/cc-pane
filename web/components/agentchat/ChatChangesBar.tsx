// 右侧面板对话的改动条：输入卡正上方一条细条「N 个文件已修改 +x −y」。
// 数据与窗格顶栏的「本轮改动」同源（collectNetChanges：agent 经 ACP 上报的 diff），
// 行数统计复用 Local History 的行级 diff 引擎（computeTextDiff），不另起后端。
// 没有上报改动时整条不渲染。
import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronUp, FileDiff } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AgentChatItem } from "@/types/agentChat";
import { computeTextDiff } from "@/services/agentChatService";
import { handleErrorSilent } from "@/utils/errorHandler";
import { collectNetChanges } from "./ChatChangesPanel";

export interface ChangeStats {
  additions: number;
  deletions: number;
}

type NetChange = ReturnType<typeof collectNetChanges>[number];

/** 逐文件算净 diff 的增删行并求和；任一文件算不出就不给统计（只显示文件数），不猜数。 */
export function useNetChangeStats(changes: NetChange[]): ChangeStats | null {
  const [stats, setStats] = useState<ChangeStats | null>(null);
  // 内容不变就不重算：items 每来一条流式更新都会生成新数组。
  const key = useMemo(
    () => JSON.stringify(changes.map((change) => [change.path, change.firstOld, change.lastNew])),
    [changes],
  );
  useEffect(() => {
    const parsed = JSON.parse(key) as [string, string, string][];
    if (parsed.length === 0) {
      setStats(null);
      return;
    }
    let cancelled = false;
    void Promise.all(parsed.map(([, oldText, newText]) => computeTextDiff(oldText, newText)))
      .then((results) => {
        if (cancelled) return;
        setStats(results.reduce<ChangeStats>((total, result) => ({
          additions: total.additions + result.stats.additions,
          deletions: total.deletions + result.stats.deletions,
        }), { additions: 0, deletions: 0 }));
      })
      .catch((error) => {
        handleErrorSilent(error, "compute dock chat change stats");
        if (!cancelled) setStats(null);
      });
    return () => {
      cancelled = true;
    };
  }, [key]);
  return stats;
}

interface ChatChangesBarProps {
  items: AgentChatItem[];
  /** 逐文件 diff 面板（ChatChangesPanel）是否展开。 */
  detailsOpen: boolean;
  onToggleDetails: () => void;
  /** 打开会话审阅标签（按本对话的检查点）；不可用时不渲染按钮。 */
  onReview?: () => void;
}

export default function ChatChangesBar({ items, detailsOpen, onToggleDetails, onReview }: ChatChangesBarProps) {
  const { t } = useTranslation("panes");
  const changes = useMemo(() => collectNetChanges(items), [items]);
  const stats = useNetChangeStats(changes);
  if (changes.length === 0) return null;
  const Chevron = detailsOpen ? ChevronDown : ChevronUp;
  return (
    <div
      data-testid="chat-changes-bar"
      className="flex h-7 min-w-0 items-center gap-1 rounded-lg border border-[var(--app-border)] pl-2 pr-0.5 text-xs text-[var(--app-text-secondary)]"
    >
      <button
        type="button"
        aria-expanded={detailsOpen}
        onClick={onToggleDetails}
        className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left transition-colors hover:text-[var(--app-text-primary)]"
      >
        <FileDiff className="size-3.5 shrink-0 text-[var(--app-text-tertiary)]" aria-hidden="true" />
        <span className="truncate">{t("agentChatChangesBarFiles", { count: changes.length })}</span>
        {stats ? (
          <span className="flex shrink-0 items-center gap-1 tabular-nums" data-testid="chat-changes-bar-stats">
            <span className="text-[var(--app-status-success)]">+{stats.additions}</span>
            <span className="text-[var(--app-status-danger)]">−{stats.deletions}</span>
          </span>
        ) : null}
        <Chevron className="size-3 shrink-0 text-[var(--app-text-tertiary)]" aria-hidden="true" />
        <span className="sr-only">{t(detailsOpen ? "agentChatChangesBarHide" : "agentChatChangesBarShow")}</span>
      </button>
      {onReview ? (
        <button
          type="button"
          onClick={onReview}
          className="h-6 shrink-0 rounded-md px-2 text-[var(--app-text-secondary)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)]"
        >
          {t("agentChatChangesBarReview")}
        </button>
      ) : null}
    </div>
  );
}
