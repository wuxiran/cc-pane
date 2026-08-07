import { useEffect, useCallback } from "react";
import { Workflow, RefreshCw, Maximize2, List, ListTree } from "lucide-react";
import { useActivityBarStore, useOrchestratorStore } from "@/stores";
import { useTranslation } from "react-i18next";
import OrchestratorFilterBar from "./OrchestratorFilterBar";
import OrchestratorTaskCard from "./OrchestratorTaskCard";
import OrchestratorTaskTree from "./OrchestratorTaskTree";
import type { OpenTerminalOptions } from "@/types";

interface OrchestratorViewProps {
  onOpenTerminal: (opts: OpenTerminalOptions) => void;
  compact?: boolean;
}

export default function OrchestratorView({
  onOpenTerminal: _onOpenTerminal,
  compact = false,
}: OrchestratorViewProps) {
  const { t } = useTranslation(["sidebar", "orchestration"]);
  const bindings = useOrchestratorStore((s) => s.bindings);
  const loading = useOrchestratorStore((s) => s.loading);
  const filterTab = useOrchestratorStore((s) => s.filterTab);
  const viewType = useOrchestratorStore((s) => s.viewType);
  const loadBindings = useOrchestratorStore((s) => s.loadBindings);
  const setFilterTab = useOrchestratorStore((s) => s.setFilterTab);
  const setViewType = useOrchestratorStore((s) => s.setViewType);

  useEffect(() => {
    loadBindings();
  }, [loadBindings]);

  const handleRefresh = useCallback(() => {
    loadBindings();
  }, [loadBindings]);

  const tabs = [
    { key: "all" as const, label: t("orchestration:filter.all") },
    { key: "running" as const, label: t("orchestration:filter.running") },
    { key: "completed" as const, label: t("orchestration:filter.done") },
  ];

  return (
    <div className="flex flex-col h-full">
      {/* 标题栏 */}
      <div
        className={`flex shrink-0 items-center gap-2 px-3 py-2 ${compact ? "px-2" : ""}`}
        style={{ borderBottom: "1px solid var(--app-border)" }}
      >
        <Workflow className="w-4 h-4" style={{ color: "var(--app-accent)" }} />
        <span className="min-w-0 truncate text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--app-text-secondary)" }}>
          {t("rightDock.orchestration", { defaultValue: "Orchestration" })}
        </span>
        {!compact && (
          <button
            className="ml-auto shrink-0 rounded p-1 transition-colors hover:bg-[var(--app-hover)]"
            onClick={() => useActivityBarStore.getState().openOrchestrationOverlay()}
            title="Open overlay"
          >
            <Maximize2 className="w-3.5 h-3.5" style={{ color: "var(--app-text-tertiary)" }} />
          </button>
        )}
        <button
          className={`${compact ? "ml-auto" : ""} shrink-0 rounded p-1 transition-colors hover:bg-[var(--app-hover)]`}
          onClick={handleRefresh}
          title={t("refresh")}
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} style={{ color: "var(--app-text-tertiary)" }} />
        </button>
      </div>

      {/* 过滤 Tab */}
      <div
        className={`flex shrink-0 items-center gap-1 py-1.5 ${compact ? "px-2" : "px-3"}`}
        style={{ borderBottom: "1px solid var(--app-border)" }}
      >
        <div className="flex gap-1">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              className="rounded px-2 py-0.5 text-xs transition-colors"
              style={{
                background: filterTab === tab.key ? "var(--app-accent)" : "transparent",
                color: filterTab === tab.key ? "white" : "var(--app-text-secondary)",
              }}
              onClick={() => setFilterTab(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        {compact && (
          <div className="ml-auto flex items-center gap-0.5" aria-label="View mode">
            {([
              { type: "list" as const, icon: List, label: t("orchestration:view.list") },
              { type: "tree" as const, icon: ListTree, label: t("orchestration:view.tree") },
            ]).map(({ type, icon: Icon, label }) => (
              <button
                key={type}
                type="button"
                aria-label={label}
                title={label}
                className="flex h-6 w-6 items-center justify-center rounded transition-colors"
                style={{
                  background: viewType === type ? "color-mix(in srgb, var(--app-accent) 16%, transparent)" : "transparent",
                  color: viewType === type ? "var(--app-accent)" : "var(--app-text-secondary)",
                }}
                onClick={() => setViewType(type)}
              >
                <Icon className="h-3.5 w-3.5" />
              </button>
            ))}
          </div>
        )}
      </div>

      <OrchestratorFilterBar compact={compact} />

      {!compact && (
        <div
          className="flex shrink-0 items-center justify-end gap-1 px-3 py-1"
          style={{ borderBottom: "1px solid var(--app-border)" }}
        >
          {(["list", "tree"] as const).map((type) => (
            <button
              key={type}
              className="rounded px-2 py-0.5 text-[11px] capitalize transition-colors"
              style={{
                background: viewType === type ? "var(--app-accent)" : "transparent",
                color: viewType === type ? "white" : "var(--app-text-secondary)",
              }}
              onClick={() => setViewType(type)}
            >
              {type}
            </button>
          ))}
        </div>
      )}

      {/* 任务列表 */}
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-2 py-1">
        {bindings.length === 0 && !loading && (
          <div className="flex flex-col items-center justify-center py-8 gap-2">
            <Workflow className="w-8 h-8" style={{ color: "var(--app-text-tertiary)", opacity: 0.5 }} />
            <span className="text-xs" style={{ color: "var(--app-text-tertiary)" }}>
              {t("orchestration:emptyTasks.title")}
            </span>
          </div>
        )}
        {viewType === "tree" ? (
          <OrchestratorTaskTree />
        ) : (
          bindings.map((binding) => (
            <OrchestratorTaskCard
              key={binding.id}
              binding={binding}
            />
          ))
        )}
      </div>

    </div>
  );
}
