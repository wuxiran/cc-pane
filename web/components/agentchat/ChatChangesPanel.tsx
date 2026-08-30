// 本轮改动审查面板：聚合会话内所有 tool call 的 diff 块，按文件归并出
// 「首个 oldText → 最后 newText」的净 diff。数据全部来自 agent 经 ACP 上报的
// diff 内容（不扫磁盘）——agent 没报 diff 的改动这里看不见，属诚实降级。
import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AgentChatItem } from "@/types/agentChat";
import { DiffBlockView } from "./ToolCallCard";

interface NetChange {
  path: string;
  firstOld: string;
  lastNew: string;
}

export function collectNetChanges(items: AgentChatItem[]): NetChange[] {
  const map = new Map<string, NetChange>();
  for (const item of items) {
    if (item.type !== "tool_call") continue;
    for (const block of item.call.content ?? []) {
      if (block.type !== "diff" || !block.path) continue;
      const existing = map.get(block.path);
      if (existing) {
        existing.lastNew = block.newText ?? existing.lastNew;
      } else {
        map.set(block.path, {
          path: block.path,
          firstOld: block.oldText ?? "",
          lastNew: block.newText ?? "",
        });
      }
    }
  }
  return [...map.values()];
}

export interface ChatChangesPanelProps {
  items: AgentChatItem[];
  cwd: string;
  onOpenFile: (path: string) => void;
}

export default function ChatChangesPanel({ items, cwd, onOpenFile }: ChatChangesPanelProps) {
  const { t } = useTranslation("panes");
  const [expandedPath, setExpandedPath] = useState<string | null>(null);

  const changes = useMemo(() => collectNetChanges(items), [items]);

  const relative = (path: string) => {
    const normalizedCwd = cwd.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const normalizedPath = path.replace(/\\/g, "/");
    return normalizedPath.toLowerCase().startsWith(`${normalizedCwd}/`)
      ? normalizedPath.slice(normalizedCwd.length + 1)
      : path;
  };

  if (changes.length === 0) {
    return (
      <div className="border-t border-[var(--app-border)] px-4 py-3 text-center text-[11px] text-[var(--app-icon-inactive)]">
        {t("agentChatNoChanges")}
      </div>
    );
  }

  return (
    <div className="max-h-[45%] overflow-y-auto border-t border-[var(--app-border)] px-3 py-2">
      <div className="mx-auto flex max-w-3xl flex-col gap-1">
        <div className="text-[11px] font-medium text-[var(--app-icon-inactive)]">
          {t("agentChatChangesTitle", { count: changes.length })}
        </div>
        {changes.map((change) => {
          const expanded = expandedPath === change.path;
          return (
            <div key={change.path} className="rounded-md border border-[var(--app-border)]">
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5 text-left text-xs transition-colors hover:bg-[var(--app-hover)]"
                  onClick={() => setExpandedPath(expanded ? null : change.path)}
                >
                  {expanded ? (
                    <ChevronDown className="h-3 w-3 shrink-0 text-[var(--app-icon-inactive)]" />
                  ) : (
                    <ChevronRight className="h-3 w-3 shrink-0 text-[var(--app-icon-inactive)]" />
                  )}
                  <span className="truncate font-mono" title={change.path}>
                    {relative(change.path)}
                  </span>
                </button>
                <button
                  type="button"
                  aria-label={t("agentChatOpenFile")}
                  title={t("agentChatOpenFile")}
                  className="mr-1 shrink-0 rounded p-1 text-[var(--app-icon-inactive)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-icon-active)]"
                  onClick={() => onOpenFile(change.path)}
                >
                  <ExternalLink className="h-3 w-3" />
                </button>
              </div>
              {expanded ? (
                <div className="border-t border-[var(--app-border)] p-1.5">
                  <DiffBlockView
                    block={{
                      type: "diff",
                      path: change.path,
                      oldText: change.firstOld,
                      newText: change.lastNew,
                    }}
                  />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
