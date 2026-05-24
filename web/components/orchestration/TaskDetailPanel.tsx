import { useMemo, useState, type ReactNode } from "react";
import { Check, ChevronRight, Clipboard, ExternalLink, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
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
      <h3 className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--app-text-tertiary)" }}>
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
  const [promptOpen, setPromptOpen] = useState(true);
  const [copied, setCopied] = useState(false);

  const metadata = useMemo(() => asRecord(binding?.metadata), [binding?.metadata]);
  const uiMetadata = useMemo(() => asRecord(metadata?.ui), [metadata]);
  const timeline = useMemo<[string, string | undefined][]>(
    () => [
      ["Created", binding?.createdAt],
      ["Started", asString(uiMetadata?.startedAt) ?? asString(metadata?.startedAt)],
      ["Completed", asString(uiMetadata?.completedAt) ?? asString(metadata?.completedAt)],
    ],
    [binding?.createdAt, metadata, uiMetadata]
  );

  if (!binding) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <FileText className="h-10 w-10" style={{ color: "var(--app-text-tertiary)" }} />
        <div>
          <div className="text-sm font-medium" style={{ color: "var(--app-text-primary)" }}>
            No task selected
          </div>
          <div className="mt-1 text-xs" style={{ color: "var(--app-text-tertiary)" }}>
            Select a task from the orchestration list.
          </div>
        </div>
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
      for (const pane of panes.allPanels()) {
        const tabIndex = pane.tabs.findIndex((tab) => tab.sessionId === binding.sessionId);
        if (tabIndex >= 0) {
          // fix(C3) review: 详情页直接激活 pane/tab，不再依赖未监听的 focus-session 事件。
          panes.setActivePane(pane.id);
          panes.switchToTab(pane.id, tabIndex);
          break;
        }
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
            title="View in PTY"
          >
            <ExternalLink className="h-4 w-4" />
            View in PTY
          </Button>
        </header>

        <DetailSection title="Prompt">
          <div className="rounded-md" style={{ border: "1px solid var(--app-border)" }}>
            <button
              type="button"
              className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs"
              onClick={() => setPromptOpen((open) => !open)}
              style={{ color: "var(--app-text-secondary)" }}
            >
              <span className="flex items-center gap-1.5">
                <ChevronRight className={`h-3.5 w-3.5 transition-transform ${promptOpen ? "rotate-90" : ""}`} />
                {binding.prompt ? "Prompt content" : "No prompt stored"}
              </span>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={(event) => {
                  event.stopPropagation();
                  void copyPrompt();
                }}
                disabled={!binding.prompt}
                title="Copy prompt"
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

        <DetailSection title="Timeline">
          <div className="grid gap-2 rounded-md p-3" style={{ border: "1px solid var(--app-border)" }}>
            {timeline.map(([label, value]) => (
              <InfoRow key={label} label={label} value={formatDate(value)} />
            ))}
          </div>
        </DetailSection>

        <DetailSection title="Result">
          <div className="grid gap-2 rounded-md p-3" style={{ border: "1px solid var(--app-border)" }}>
            <InfoRow label="Exit code" value={binding.exitCode ?? "-"} />
            <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-3 text-xs">
              <span style={{ color: "var(--app-text-tertiary)" }}>Summary</span>
              <span className="min-w-0 whitespace-pre-wrap break-words" style={{ color: summaryColor }}>
                {binding.completionSummary || "-"}
              </span>
            </div>
          </div>
        </DetailSection>

        <DetailSection title="Session">
          <div className="grid gap-2 rounded-md p-3" style={{ border: "1px solid var(--app-border)" }}>
            <InfoRow label="Session ID" value={binding.sessionId} />
            <InfoRow label="Resume ID" value={binding.resumeId} />
            <InfoRow label="Pane / Tab" value={[binding.paneId, binding.tabId].filter(Boolean).join(" / ")} />
            <InfoRow label="Workspace" value={binding.workspaceName} />
            <InfoRow label="Project" value={binding.projectPath} />
          </div>
        </DetailSection>

        <DetailSection title="Metadata">
          <div
            className="max-h-96 overflow-auto rounded-md p-3 font-mono text-[11px] leading-5"
            style={{ border: "1px solid var(--app-border)", color: "var(--app-text-secondary)" }}
          >
            {binding.metadata === undefined || binding.metadata === null ? (
              <span style={{ color: "var(--app-text-tertiary)" }}>No metadata</span>
            ) : (
              <JsonNode value={binding.metadata} />
            )}
          </div>
        </DetailSection>
      </div>
    </div>
  );
}
