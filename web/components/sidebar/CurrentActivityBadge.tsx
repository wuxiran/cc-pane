import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useTerminalStatusStore } from "@/stores";
import type { TaskBinding, TerminalStatusInfo } from "@/types";
import { getMetadataUi } from "./OrchestratorTaskUtils";

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

function toolLabel(info: TerminalStatusInfo): string | null {
  const tool = info.currentToolName;
  if (!tool) return null;
  const summary = compactSummary(info.currentToolSummary);
  const lower = tool.toLowerCase();
  if (lower.includes("bash")) return `💻 Bash${summary ? ` '${summary}'` : ""}`;
  if (lower.includes("edit") || lower.includes("write")) {
    return `🔧 ${tool}${summary ? ` ${summary}` : ""}`;
  }
  if (lower.includes("read") || lower.includes("grep") || lower.includes("glob")) {
    return `🔎 ${tool}${summary ? ` ${summary}` : ""}`;
  }
  return `🔧 ${tool}${summary ? ` ${summary}` : ""}`;
}

function deriveLabel(binding: TaskBinding, info: TerminalStatusInfo | null, now: number): string {
  if (info?.status === "waitingInput" || binding.status === "waiting") {
    return "⏸ Waiting input";
  }
  if (binding.status === "pending") return "⏳ Pending";
  if (binding.status === "completed") return "✅ Done";
  if (binding.status === "failed") return "❌ Failed";

  if (binding.status === "running") {
    if (info?.updatedAt && now - info.updatedAt > 60000) {
      return "⏱ 1m+";
    }
    const label = info ? toolLabel(info) : null;
    return label ?? "💭 Thinking";
  }

  if (info?.status === "idle") return "⏸ Waiting input";
  return "💭 Thinking";
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
  const { info } = useTerminalStatusStore(
    useShallow((s) => ({
      // fix(C4,H5) review: 直接从 TerminalStatusStore 读当前 session，避免 CurrentToolStore 和不稳选择器。
      info: binding.sessionId ? s.statusMap.get(binding.sessionId) ?? null : null,
    }))
  );
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 15000);
    return () => window.clearInterval(interval);
  }, []);

  const label = useMemo(() => deriveLabel(binding, info, now), [binding, info, now]);
  const duration = formatDuration(now - startedAtMillis(binding));

  return (
    <span
      className="inline-flex min-w-0 items-center rounded px-1.5 py-0.5 text-[10px]"
      style={{
        color: "var(--app-text-secondary)",
        background: "var(--app-input-bg)",
        border: "1px solid var(--app-border)",
      }}
      title={`${label} · ${duration}`}
    >
      <span className="truncate">{label}</span>
    </span>
  );
}
