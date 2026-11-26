import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useShallow } from "zustand/react/shallow";
import { Brain, CirclePause, Search, SquareTerminal, Timer, Wrench, type LucideIcon } from "lucide-react";
import { useTerminalStatusStore } from "@/stores";
import type { TaskBinding, TerminalStatusInfo } from "@/types";
import { getMetadataUi } from "./OrchestratorTaskUtils";
import { startVisibleInterval } from "@/utils/visibleInterval";

function startedAtMillis(binding: TaskBinding): number {
  const startedAt = getMetadataUi(binding).startedAt;
  if (typeof startedAt === "number") return startedAt;
  if (typeof startedAt === "string") {
    const parsed = new Date(startedAt).getTime();
    if (Number.isFinite(parsed)) return parsed;
  }
  return new Date(binding.createdAt).getTime();
}

function compactSummary(summary?: string): string {
  if (!summary) return "";
  const trimmed = summary.trim().replace(/\s+/g, " ");
  if (trimmed.length <= 32) return trimmed;
  return `${trimmed.slice(0, 31)}...`;
}

interface Activity {
  icon: LucideIcon;
  /** 已翻译文案，或原样展示的工具名 + 摘要 */
  text: string;
}

function toolActivity(info: TerminalStatusInfo): Activity | null {
  const tool = info.currentToolName;
  if (!tool) return null;
  const summary = compactSummary(info.currentToolSummary);
  const lower = tool.toLowerCase();
  if (lower.includes("bash")) {
    return { icon: SquareTerminal, text: `Bash${summary ? ` '${summary}'` : ""}` };
  }
  const text = `${tool}${summary ? ` ${summary}` : ""}`;
  if (lower.includes("read") || lower.includes("grep") || lower.includes("glob")) {
    return { icon: Search, text };
  }
  return { icon: Wrench, text };
}

type Translate = TFunction<"orchestration">;

/** 只描述「运行中的任务此刻在干什么」；任务状态本身由卡片的状态标记表达，这里不重复。 */
function deriveActivity(info: TerminalStatusInfo | null, now: number, t: Translate): Activity {
  if (info?.status === "waitingInput") {
    return { icon: CirclePause, text: t("activity.waitingInput") };
  }
  if (info?.updatedAt && now - info.updatedAt > 60000) {
    return { icon: Timer, text: t("activity.stale") };
  }
  return (info ? toolActivity(info) : null) ?? { icon: Brain, text: t("activity.thinking") };
}

function formatDuration(ms: number): string {
  if (ms < 60000) return "<1m";
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

interface CurrentActivityBadgeProps {
  binding: TaskBinding;
}

export default function CurrentActivityBadge({ binding }: CurrentActivityBadgeProps) {
  const { t } = useTranslation("orchestration");
  const { info } = useTerminalStatusStore(
    useShallow((s) => ({
      // fix(C4,H5) review: 直接从 TerminalStatusStore 读当前 session，避免 CurrentToolStore 和不稳选择器。
      info: binding.sessionId ? s.statusMap.get(binding.sessionId) ?? null : null,
    }))
  );
  const [now, setNow] = useState(Date.now());
  const running = binding.status === "running";

  useEffect(() => {
    if (!running) return undefined;
    return startVisibleInterval(() => setNow(Date.now()), 15000);
  }, [running]);

  const activity = useMemo(() => deriveActivity(info, now, t), [info, now, t]);
  if (!running) return null;

  const elapsed = t("activity.elapsed", { duration: formatDuration(now - startedAtMillis(binding)) });
  const Icon = activity.icon;

  return (
    <span
      data-testid="task-activity"
      className="inline-flex min-w-0 items-center gap-1 text-[length:var(--text-micro)] text-[var(--app-text-secondary)]"
      title={`${activity.text} · ${elapsed}`}
    >
      <Icon aria-hidden className="size-3 shrink-0 text-[var(--app-text-tertiary)]" />
      <span className="truncate">{activity.text}</span>
    </span>
  );
}
