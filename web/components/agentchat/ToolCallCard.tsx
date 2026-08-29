// ACP 工具调用卡片：折叠头（图标 + 标题 + 状态）+ 展开区（入参 / 产出 / diff）。
import { useState } from "react";
import {
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
  Globe2,
  Loader2,
  MoveRight,
  Pencil,
  Search,
  Terminal,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { AcpToolCall, AcpToolCallContent } from "@/types/agentChat";

const KIND_ICON: Record<string, LucideIcon> = {
  read: FileText,
  edit: Pencil,
  delete: Trash2,
  move: MoveRight,
  search: Search,
  execute: Terminal,
  think: Brain,
  fetch: Globe2,
};

function StatusBadge({ status }: { status?: string }) {
  switch (status) {
    case "in_progress":
      return <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--app-icon-inactive)]" />;
    case "completed":
      return <Check className="h-3.5 w-3.5 text-[var(--app-status-success)]" />;
    case "failed":
      return <X className="h-3.5 w-3.5 text-[var(--app-status-danger)]" />;
    default:
      return <span className="h-1.5 w-1.5 rounded-full bg-[var(--app-icon-inactive)]" />;
  }
}

function stringifyCompact(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function ContentBlockView({ block }: { block: AcpToolCallContent }) {
  if (block.type === "diff") {
    return (
      <div className="rounded border border-[var(--app-border)] overflow-hidden">
        <div className="px-2 py-1 text-[11px] font-mono bg-[var(--app-hover)] text-[var(--app-icon-inactive)]">
          diff · {block.path ?? ""}
        </div>
        {block.oldText ? (
          <pre className="px-2 py-1 text-[11px] font-mono whitespace-pre-wrap break-all bg-[var(--app-status-danger-bg)] text-[var(--app-status-danger)] max-h-40 overflow-auto">
            {block.oldText}
          </pre>
        ) : null}
        <pre className="px-2 py-1 text-[11px] font-mono whitespace-pre-wrap break-all bg-[var(--app-status-success-bg)] text-[var(--app-status-success)] max-h-60 overflow-auto">
          {block.newText ?? ""}
        </pre>
      </div>
    );
  }
  const text =
    block.type === "content"
      ? (block.content?.text ?? `[${block.content?.type ?? "content"}]`)
      : stringifyCompact(block);
  if (!text) return null;
  return (
    <pre className="px-2 py-1 text-[11px] font-mono whitespace-pre-wrap break-all max-h-60 overflow-auto rounded bg-[var(--app-hover)]">
      {text}
    </pre>
  );
}

export default function ToolCallCard({ call }: { call: AcpToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const Icon = KIND_ICON[call.kind ?? ""] ?? Wrench;
  const input = stringifyCompact(call.rawInput);
  const hasBody = Boolean(input || (call.content && call.content.length > 0));

  return (
    <div className="rounded-md border border-[var(--app-border)] bg-[var(--app-panel-bg,transparent)] text-sm">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-[var(--app-hover)] rounded-md"
        onClick={() => setExpanded((value) => !value)}
      >
        {hasBody ? (
          expanded ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--app-icon-inactive)]" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--app-icon-inactive)]" />
          )
        ) : (
          <span className="w-3.5 shrink-0" />
        )}
        <Icon className="h-3.5 w-3.5 shrink-0 text-[var(--app-icon-inactive)]" />
        <span className="flex-1 truncate text-xs">
          {call.title || call.kind || call.toolCallId}
        </span>
        <StatusBadge status={call.status} />
      </button>
      {expanded && hasBody && (
        <div className="flex flex-col gap-1.5 px-2.5 pb-2">
          {input ? (
            <pre className="px-2 py-1 text-[11px] font-mono whitespace-pre-wrap break-all max-h-40 overflow-auto rounded bg-[var(--app-hover)]">
              {input}
            </pre>
          ) : null}
          {(call.content ?? []).map((block, index) => (
            <ContentBlockView key={index} block={block} />
          ))}
        </div>
      )}
    </div>
  );
}
