// agent-chat 消息条目渲染（气泡/图片/工具卡/plan/notice）与头部小选择器。
// 从 AgentChatTabContent 拆出（行数棘轮），纯展示层：状态与动作全部经 props 注入。
import { useState } from "react";
import { Check, ChevronDown, Copy, ImageIcon, ListTodo } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { AcpPlanEntry, AgentChatItem } from "@/types/agentChat";
import { handleErrorSilent } from "@/utils/errorHandler";
import ChatMarkdown from "./ChatMarkdown";
import ToolCallCard from "./ToolCallCard";

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="rounded p-0.5 text-[var(--app-icon-inactive)] opacity-0 transition-opacity group-hover:opacity-100 hover:bg-[var(--app-hover)] hover:text-[var(--app-icon-active)]"
      onClick={() => {
        void navigator.clipboard
          .writeText(text)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          })
          .catch((error) => handleErrorSilent(error, "copy chat message"));
      }}
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

export interface ItemViewProps {
  item: AgentChatItem;
  onOpenLocation: (path: string, line?: number) => void;
  onPlanToTodo: (entries: AcpPlanEntry[]) => void;
  expandAllSignal?: { seq: number; expanded: boolean };
}

export function ItemView({ item, onOpenLocation, onPlanToTodo, expandAllSignal }: ItemViewProps) {
  const { t } = useTranslation("panes");
  switch (item.type) {
    case "user":
      return (
        <div className="flex flex-col items-end gap-1">
          {item.attachmentLabels && item.attachmentLabels.length > 0 ? (
            <div className="flex flex-wrap justify-end gap-1">
              {item.attachmentLabels.map((label, index) => (
                <span
                  key={index}
                  className="flex items-center gap-1 rounded border border-[var(--app-border)] px-1.5 py-0.5 text-[11px] text-[var(--app-icon-inactive)]"
                >
                  <ImageIcon className="h-3 w-3" /> {label}
                </span>
              ))}
            </div>
          ) : null}
          {item.text ? (
            <div className="max-w-[85%] rounded-lg bg-[var(--app-active-bg)] px-3 py-1.5 text-sm whitespace-pre-wrap break-words">
              {item.text}
            </div>
          ) : null}
        </div>
      );
    case "assistant":
      return (
        <div className="group relative">
          <div className="absolute -top-1 right-0 z-[1]">
            <CopyButton text={item.text} label={t("agentChatCopy")} />
          </div>
          <ChatMarkdown text={item.text} onOpenFile={onOpenLocation} />
        </div>
      );
    case "image":
      return (
        <img
          src={`data:${item.mimeType};base64,${item.data}`}
          alt="agent output"
          className="max-h-96 max-w-full self-start rounded border border-[var(--app-border)]"
        />
      );
    case "thought":
      return (
        <div className="border-l-2 border-[var(--app-border)] pl-2 text-xs italic text-[var(--app-icon-inactive)] whitespace-pre-wrap break-words">
          {item.text}
        </div>
      );
    case "tool_call":
      return (
        <ToolCallCard
          call={item.call}
          onOpenLocation={onOpenLocation}
          expandAllSignal={expandAllSignal}
        />
      );
    case "plan":
      return (
        <div className="rounded-md border border-[var(--app-border)] px-2.5 py-1.5">
          <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--app-icon-inactive)]">
            <ListTodo className="h-3.5 w-3.5" /> {t("agentChatPlanTitle")}
            <span className="flex-1" />
            <button
              type="button"
              className="rounded border border-[var(--app-border)] px-1.5 py-0.5 text-[10px] transition-colors hover:bg-[var(--app-hover)]"
              onClick={() => onPlanToTodo(item.entries)}
            >
              {t("agentChatPlanToTodo")}
            </button>
          </div>
          <ul className="mt-1 flex flex-col gap-0.5">
            {item.entries.map((entry, index) => (
              <li key={index} className="flex items-start gap-1.5 text-xs">
                <span
                  className={
                    entry.status === "completed"
                      ? "text-[var(--app-status-success)]"
                      : entry.status === "in_progress"
                        ? "text-[var(--app-status-warning)]"
                        : "text-[var(--app-icon-inactive)]"
                  }
                >
                  {entry.status === "completed" ? "✓" : entry.status === "in_progress" ? "▸" : "○"}
                </span>
                <span
                  className={
                    entry.status === "completed"
                      ? "line-through text-[var(--app-icon-inactive)]"
                      : ""
                  }
                >
                  {entry.content}
                </span>
              </li>
            ))}
          </ul>
        </div>
      );
    case "notice":
      return (
        <div className="text-center text-[11px] text-[var(--app-icon-inactive)] break-all">
          {item.text}
        </div>
      );
    default:
      return null;
  }
}

/** 头部的小型选择器（模式/模型共用）：显示当前项，下拉列出可选项。 */
export function HeaderSelect({
  items,
  currentId,
  onSelect,
}: {
  items: { id: string; label: string; description?: string }[];
  currentId?: string;
  onSelect: (id: string) => void;
}) {
  const current = items.find((item) => item.id === currentId);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1 rounded border border-[var(--app-border)] px-1.5 py-0.5 text-[11px] text-[var(--app-icon-inactive)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-icon-active)]"
        >
          <span className="max-w-40 truncate">{current?.label ?? currentId ?? "…"}</span>
          <ChevronDown className="h-3 w-3 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {items.map((item) => (
          <DropdownMenuItem
            key={item.id}
            title={item.description}
            onSelect={() => onSelect(item.id)}
          >
            <span className="flex-1 truncate">{item.label}</span>
            {item.id === currentId ? <Check className="h-3.5 w-3.5" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
