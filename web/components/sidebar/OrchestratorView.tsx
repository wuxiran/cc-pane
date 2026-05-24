import { useEffect, useCallback } from "react";
import { Workflow, RefreshCw, Maximize2 } from "lucide-react";
import { useActivityBarStore, useOrchestratorStore } from "@/stores";
import { useTranslation } from "react-i18next";
import OrchestratorFilterBar from "./OrchestratorFilterBar";
import OrchestratorTaskCard from "./OrchestratorTaskCard";
import OrchestratorTaskTree from "./OrchestratorTaskTree";
import OrchestratorInput from "./OrchestratorInput";
import type { OpenTerminalOptions } from "@/types";

interface OrchestratorViewProps {
  onOpenTerminal: (opts: OpenTerminalOptions) => void;
}

export default function OrchestratorView({ onOpenTerminal: _onOpenTerminal }: OrchestratorViewProps) {
  const { t } = useTranslation("sidebar");
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
    { key: "all" as const, label: t("orchestrationAll", { defaultValue: "All" }) },
    { key: "running" as const, label: t("orchestrationRunning", { defaultValue: "Running" }) },
    { key: "completed" as const, label: t("orchestrationCompleted", { defaultValue: "Done" }) },
  ];

  return (
    <div className="flex flex-col h-full">
      {/* 标题栏 */}
      <div
        className="flex items-center gap-2 px-3 py-2 shrink-0"
        style={{ borderBottom: "1px solid var(--app-border)" }}
      >
        <Workflow className="w-4 h-4" style={{ color: "var(--app-accent)" }} />
        <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--app-text-secondary)" }}>
          {t("orchestration", { defaultValue: "Orchestration" })}
        </span>
        <button
          className="ml-auto p-1 rounded hover:bg-[var(--app-hover)] transition-colors"
          onClick={() => useActivityBarStore.getState().openOrchestrationOverlay()}
          title="Open overlay"
        >
          <Maximize2 className="w-3.5 h-3.5" style={{ color: "var(--app-text-tertiary)" }} />
        </button>
        <button
          className="p-1 rounded hover:bg-[var(--app-hover)] transition-colors"
          onClick={handleRefresh}
          title={t("refresh", { ns: "common", defaultValue: "Refresh" })}
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} style={{ color: "var(--app-text-tertiary)" }} />
        </button>
      </div>

      {/* 过滤 Tab */}
      <div
        className="flex gap-1 px-3 py-1.5 shrink-0"
        style={{ borderBottom: "1px solid var(--app-border)" }}
      >
        {tabs.map((tab) => (
          <button
            key={tab.key}
            className="px-2 py-0.5 text-xs rounded transition-colors"
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

      <OrchestratorFilterBar />

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

      {/* 任务列表 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
        {bindings.length === 0 && !loading && (
          <div className="flex flex-col items-center justify-center py-8 gap-2">
            <Workflow className="w-8 h-8" style={{ color: "var(--app-text-tertiary)", opacity: 0.5 }} />
            <span className="text-xs" style={{ color: "var(--app-text-tertiary)" }}>
              {t("orchestrationEmpty", { defaultValue: "No tasks yet" })}
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

      {/* 底部对话输入 */}
      <OrchestratorInput />
    </div>
  );
}
