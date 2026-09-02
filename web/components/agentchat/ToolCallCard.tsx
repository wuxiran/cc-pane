// ACP 工具调用卡片：折叠头（图标 + 标题 + 状态）+ 展开区（入参 / 产出 / diff /
// 文件位置）。diff 展开后走 Local History 的 diff 引擎（compute_text_diff）
// 渲染行级 DiffView；计算是惰性的——只有展开的卡片才发一次请求。
import { useEffect, useState } from "react";
import {
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
  Globe2,
  Loader2,
  MapPin,
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
import { computeTextDiff } from "@/services/agentChatService";
import type { DiffResult } from "@/services/localHistoryService";
import { handleErrorSilent } from "@/utils/errorHandler";
import DiffView from "@/components/DiffView";
import { useAgentChatStore } from "@/stores/useAgentChatStore";

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

/** diff 块：惰性计算行级 diff；引擎不可用时回落 old/new 两段叠色。
 * export 给 ChatChangesPanel 复用（本轮改动聚合视图）。 */
export function DiffBlockView({ block }: { block: AcpToolCallContent }) {
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [failed, setFailed] = useState(false);

  const oldText = block.oldText ?? "";
  const newText = block.newText ?? "";

  useEffect(() => {
    let cancelled = false;
    setDiff(null);
    setFailed(false);
    computeTextDiff(oldText, newText)
      .then((result) => {
        if (!cancelled) setDiff(result);
      })
      .catch((error) => {
        handleErrorSilent(error, "compute acp tool diff");
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [oldText, newText]);

  return (
    <div className="rounded border border-[var(--app-border)] overflow-hidden">
      <div className="px-2 py-1 text-[11px] font-mono bg-[var(--app-hover)] text-[var(--app-icon-inactive)]">
        diff · {block.path ?? ""}
      </div>
      {failed ? (
        <>
          {block.oldText ? (
            <pre className="px-2 py-1 text-[11px] font-mono whitespace-pre-wrap break-all bg-[var(--app-status-danger-bg)] text-[var(--app-status-danger)] max-h-40 overflow-auto">
              {block.oldText}
            </pre>
          ) : null}
          <pre className="px-2 py-1 text-[11px] font-mono whitespace-pre-wrap break-all bg-[var(--app-status-success-bg)] text-[var(--app-status-success)] max-h-60 overflow-auto">
            {newText}
          </pre>
        </>
      ) : (
        <div className="max-h-80 overflow-auto">
          <DiffView diff={diff} loading={diff === null} />
        </div>
      )}
    </div>
  );
}

/** `{type:"terminal", terminalId}`：agent 经客户端 terminal 能力跑的命令，输出由
 * `terminal_output` 事件实时推进 store；这里只订阅该 terminalId。 */
function TerminalBlockView({ chatId, terminalId }: { chatId: string; terminalId: string }) {
  const terminal = useAgentChatStore((s) => s.chats[chatId]?.terminals[terminalId]);
  const exit = terminal?.exitStatus;
  const status = !terminal
    ? "…"
    : exit
      ? exit.exitCode !== undefined
        ? `exit ${exit.exitCode}`
        : exit.signal ?? "exited"
      : "running";
  return (
    <div className="rounded border border-[var(--app-border)] overflow-hidden">
      <div className="flex items-center justify-between px-2 py-1 text-[11px] font-mono bg-[var(--app-hover)] text-[var(--app-icon-inactive)]">
        <span>terminal · {terminalId}</span>
        <span
          className={
            exit && exit.exitCode !== undefined && exit.exitCode !== 0
              ? "text-[var(--app-status-danger)]"
              : undefined
          }
        >
          {status}
          {terminal?.truncated ? " · truncated" : ""}
        </span>
      </div>
      {terminal?.output ? (
        <pre className="px-2 py-1 text-[11px] font-mono whitespace-pre-wrap break-all max-h-60 overflow-auto">
          {terminal.output}
        </pre>
      ) : null}
    </div>
  );
}

function ContentBlockView({ block, chatId }: { block: AcpToolCallContent; chatId?: string }) {
  if (block.type === "diff") {
    return <DiffBlockView block={block} />;
  }
  if (block.type === "terminal" && typeof block.terminalId === "string" && chatId) {
    return <TerminalBlockView chatId={chatId} terminalId={block.terminalId} />;
  }
  // 工具产出里的图片块（截图类工具常见）真渲染。
  if (block.type === "content" && block.content?.type === "image") {
    const image = block.content as { data?: unknown; mimeType?: unknown };
    if (typeof image.data === "string" && image.data) {
      const mime = typeof image.mimeType === "string" ? image.mimeType : "image/png";
      return (
        <img
          src={`data:${mime};base64,${image.data}`}
          alt="tool output"
          className="max-h-80 max-w-full rounded border border-[var(--app-border)]"
        />
      );
    }
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

interface ToolCallCardProps {
  call: AcpToolCall;
  /** 所属会话（terminal 内容块要按它订阅实时输出）。 */
  chatId?: string;
  /** 位置 chip 点击时打开文件（由标签内容组件注入项目上下文）。 */
  onOpenLocation?: (path: string, line?: number) => void;
  /** 全局展开/折叠信号：seq 变化时把本卡置为 expanded 值。 */
  expandAllSignal?: { seq: number; expanded: boolean };
}

export default function ToolCallCard({ call, chatId, onOpenLocation, expandAllSignal }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (expandAllSignal && expandAllSignal.seq > 0) {
      setExpanded(expandAllSignal.expanded);
    }
  }, [expandAllSignal]);
  const Icon = KIND_ICON[call.kind ?? ""] ?? Wrench;
  const input = stringifyCompact(call.rawInput);
  const output = stringifyCompact(call.rawOutput);
  const locations = call.locations ?? [];
  const hasBody = Boolean(
    input || output || (call.content && call.content.length > 0) || locations.length > 0,
  );

  return (
    <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-overlay)] text-sm shadow-sm">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-[var(--app-hover)] rounded-lg"
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
          {locations.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {locations.map((location, index) => (
                <button
                  key={`${location.path}-${index}`}
                  type="button"
                  className="flex items-center gap-1 rounded border border-[var(--app-border)] px-1.5 py-0.5 text-[11px] font-mono text-[var(--app-icon-inactive)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-icon-active)] disabled:cursor-default"
                  disabled={!onOpenLocation}
                  onClick={() => onOpenLocation?.(location.path, location.line)}
                  title={location.path}
                >
                  <MapPin className="h-3 w-3 shrink-0" />
                  <span className="max-w-64 truncate">
                    {location.path}
                    {location.line !== undefined ? `:${location.line}` : ""}
                  </span>
                </button>
              ))}
            </div>
          ) : null}
          {input ? (
            <pre className="px-2 py-1 text-[11px] font-mono whitespace-pre-wrap break-all max-h-40 overflow-auto rounded bg-[var(--app-hover)]">
              {input}
            </pre>
          ) : null}
          {(call.content ?? []).map((block, index) => (
            <ContentBlockView key={index} block={block} chatId={chatId} />
          ))}
          {output ? (
            <pre className="px-2 py-1 text-[11px] font-mono whitespace-pre-wrap break-all max-h-60 overflow-auto rounded bg-[var(--app-hover)]">
              {output}
            </pre>
          ) : null}
        </div>
      )}
    </div>
  );
}
