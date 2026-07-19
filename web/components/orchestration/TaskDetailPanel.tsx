import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronRight, Clipboard, ExternalLink, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/EmptyState";
import { useActivityBarStore, usePanesStore } from "@/stores";
import type { TaskBinding } from "@/types";

interface TaskDetailPanelProps {
  binding: TaskBinding | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function formatDate(value?: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function formatJsonPrimitive(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  return String(value);
}

function JsonNode({ label, value, depth = 0 }: { label?: string; value: unknown; depth?: number }) {
  if (value === null || typeof value !== "object") {
    return (
      <div className="flex gap-2 py-0.5" style={{ paddingLeft: depth * 12 }}>
        {label && <span style={{ color: "var(--app-text-tertiary)" }}>{label}:</span>}
        <span style={{ color: "var(--app-text-secondary)" }}>{formatJsonPrimitive(value)}</span>
      </div>
    );
  }

  const entries = Array.isArray(value)
    ? value.map((item, index) => [String(index), item] as const)
    : Object.entries(value as Record<string, unknown>);
  const summary = Array.isArray(value) ? `Array(${entries.length})` : `Object(${entries.length})`;

  return (
    <details open={depth < 1} className="py-0.5" style={{ paddingLeft: depth * 12 }}>
      <summary className="cursor-pointer select-none" style={{ color: "var(--app-text-secondary)" }}>
        {label && <span style={{ color: "var(--app-text-tertiary)" }}>{label}: </span>}
        {summary}
      </summary>
      <div className="pl-2">
        {entries.map(([key, child]) => (
          <JsonNode key={key} label={key} value={child} depth={depth + 1} />
        ))}
      </div>
    </details>
  );
}

function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: "var(--app-text-tertiary)" }}>
        {title}
      </h3>
      {children}
    </section>
  );
}

function InfoRow({ label, value }: { label: string; value?: ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-3 text-xs">
      <span style={{ color: "var(--app-text-tertiary)" }}>{label}</span>
      <span className="min-w-0 break-words" style={{ color: "var(--app-text-secondary)" }}>
        {value || "-"}
      </span>
    </div>
  );
}

export default function TaskDetailPanel({ binding }: TaskDetailPanelProps) {
  const { t } = useTranslation("orchestration");
  const [promptOpen, setPromptOpen] = useState(true);
  const [copied, setCopied] = useState(false);

  const metadata = useMemo(() => asRecord(binding?.metadata), [binding?.metadata]);
  const uiMetadata = useMemo(() => asRecord(metadata?.ui), [metadata]);
  const timeline = useMemo<{ key: string; label: string; value: string | undefined }[]>(
    () => [
      { key: "created", label: t("detail.created", { defaultValue: "创建" }), value: binding?.createdAt },
      {
        key: "started",
        label: t("detail.started", { defaultValue: "开始" }),
        value: asString(uiMetadata?.startedAt) ?? asString(metadata?.startedAt),
      },
      {
        key: "completed",
        label: t("detail.completed", { defaultValue: "完成" }),
        value: asString(uiMetadata?.completedAt) ?? asString(metadata?.completedAt),
      },
    ],
    [binding?.createdAt, metadata, uiMetadata, t]
  );

  if (!binding) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <EmptyState
          icon={FileText}
          title={t("detail.noTaskSelected", { defaultValue: "未选择任务" })}
          description={t("detail.noTaskSelectedDesc", { defaultValue: "从编排列表中选择一个任务。" })}
        />
      </div>
    );
  }

  const summaryColor =
    binding.status === "failed"
      ? "var(--app-status-danger)"
      : binding.status === "completed"
        ? "var(--app-status-success)"
        : "var(--app-text-secondary)";

  const copyPrompt = async () => {
    if (!binding.prompt) return;
    await navigator.clipboard.writeText(binding.prompt);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  const openPty = () => {
    if (!binding.sessionId) return;
    useActivityBarStore.getState().setAppViewMode("panes");
    window.requestAnimationFrame(() => {
      const panes = usePanesStore.getState();
      const location = panes.findTabBySessionAcrossLayouts(binding.sessionId!);
      if (location) {
        if (location.layoutId !== panes.currentLayoutId) {
          panes.switchLayout(location.layoutId);
        }
        const tabIndex = location.panel.tabs.findIndex((tab) => tab.id === location.tab.id);
        // fix(C3) review: 详情页直接激活 pane/tab，不再依赖未监听的 focus-session 事件。
        panes.setActivePane(location.panel.id);
        panes.switchToTab(location.panel.id, tabIndex);
      }
    });
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-5xl flex-col gap-6 p-5">
        <header className="flex min-w-0 items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs" style={{ color: "var(--app-text-tertiary)" }}>
              <span>{binding.role}</span>
              <span>·</span>
              <span>{binding.cliTool}</span>
              <span>·</span>
              <span>{binding.status}</span>
            </div>
            <h2 className="mt-1 truncate text-lg font-semibold" style={{ color: "var(--app-text-primary)" }}>
              {binding.title}
            </h2>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={openPty}
            disabled={!binding.sessionId}
            title={t("detail.viewInPty", { defaultValue: "在终端中查看" })}
          >
            <ExternalLink className="h-4 w-4" strokeWidth={1.5} />
            {t("detail.viewInPty", { defaultValue: "在终端中查看" })}
          </Button>
        </header>

        <DetailSection title={t("detail.prompt", { defaultValue: "提示词" })}>
          <div className="rounded-lg" style={{ border: "1px solid var(--app-border)" }}>
            <button
              type="button"
              className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs"
              onClick={() => setPromptOpen((open) => !open)}
              style={{ color: "var(--app-text-secondary)" }}
            >
              <span className="flex items-center gap-1.5">
                <ChevronRight className={`h-3.5 w-3.5 transition-transform duration-[var(--dur-fast)] ${promptOpen ? "rotate-90" : ""}`} strokeWidth={1.5} />
                {binding.prompt
                  ? t("detail.promptContent", { defaultValue: "提示词内容" })
                  : t("detail.noPromptStored", { defaultValue: "未存储提示词" })}
              </span>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={(event) => {
                  event.stopPropagation();
                  void copyPrompt();
                }}
                disabled={!binding.prompt}
                title={t("detail.copyPrompt", { defaultValue: "复制提示词" })}
              >
                {copied ? <Check className="h-3 w-3" /> : <Clipboard className="h-3 w-3" />}
              </Button>
            </button>
            {promptOpen && (
              <pre
                className="max-h-80 overflow-auto whitespace-pre-wrap break-words px-3 pb-3 text-xs leading-5"
                style={{ color: "var(--app-text-primary)" }}
              >
                {binding.prompt || "-"}
              </pre>
            )}
          </div>
        </DetailSection>

        <DetailSection title={t("detail.timeline", { defaultValue: "时间线" })}>
          <div className="grid gap-2 rounded-lg p-3" style={{ border: "1px solid var(--app-border)" }}>
            {timeline.map(({ key, label, value }) => (
              <InfoRow key={key} label={label} value={formatDate(value)} />
            ))}
          </div>
        </DetailSection>

        <DetailSection title={t("detail.result", { defaultValue: "结果" })}>
          <div className="grid gap-2 rounded-lg p-3" style={{ border: "1px solid var(--app-border)" }}>
            <InfoRow label={t("detail.exitCode", { defaultValue: "退出码" })} value={binding.exitCode ?? "-"} />
            <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-3 text-xs">
              <span style={{ color: "var(--app-text-tertiary)" }}>{t("detail.summary", { defaultValue: "摘要" })}</span>
              <span className="min-w-0 whitespace-pre-wrap break-words" style={{ color: summaryColor }}>
                {binding.completionSummary || "-"}
              </span>
            </div>
          </div>
        </DetailSection>

        <DetailSection title={t("detail.session", { defaultValue: "会话" })}>
          <div className="grid gap-2 rounded-lg p-3" style={{ border: "1px solid var(--app-border)" }}>
            <InfoRow label={t("detail.sessionId", { defaultValue: "会话 ID" })} value={binding.sessionId} />
            <InfoRow label={t("detail.resumeId", { defaultValue: "恢复 ID" })} value={binding.resumeId} />
            <InfoRow label={t("detail.paneTab", { defaultValue: "面板 / 标签" })} value={[binding.paneId, binding.tabId].filter(Boolean).join(" / ")} />
            <InfoRow label={t("detail.workspace", { defaultValue: "工作空间" })} value={binding.workspaceName} />
            <InfoRow label={t("detail.project", { defaultValue: "项目" })} value={binding.projectPath} />
          </div>
        </DetailSection>

        <DetailSection title={t("detail.metadata", { defaultValue: "元数据" })}>
          <div
            className="max-h-96 overflow-auto rounded-lg p-3 font-mono text-[11px] leading-5"
            style={{ border: "1px solid var(--app-border)", color: "var(--app-text-secondary)" }}
          >
            {binding.metadata === undefined || binding.metadata === null ? (
              <span style={{ color: "var(--app-text-tertiary)" }}>{t("detail.noMetadata", { defaultValue: "无元数据" })}</span>
            ) : (
              <JsonNode value={binding.metadata} />
            )}
          </div>
        </DetailSection>
      </div>
    </div>
  );
}
