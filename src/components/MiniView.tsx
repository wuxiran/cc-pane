import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { Maximize2, Pin } from "lucide-react";
import { usePanesStore, useTerminalStatusStore, useMiniModeStore } from "@/stores";
import StatusIndicator from "@/components/StatusIndicator";
import type { Tab } from "@/types";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauriReady, handleErrorSilent } from "@/utils";

export default function MiniView() {
  const { t } = useTranslation("common");
  const rootPane = usePanesStore((s) => s.rootPane);
  const allPanels = usePanesStore((s) => s.allPanels);
  const getStatus = useTerminalStatusStore((s) => s.getStatus);
  const exitMiniMode = useMiniModeStore((s) => s.exitMiniMode);

  const [isPinned, setIsPinned] = useState(true);

  const activeTabs = useMemo<Tab[]>(() => {
    const tabs: Tab[] = [];
    for (const panel of allPanels()) {
      for (const tab of panel.tabs) {
        if (tab.sessionId) tabs.push(tab);
      }
    }
    return tabs;
    // rootPane 变化时重新计算，allPanels 是派生方法
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootPane]);

  async function togglePin() {
    try {
      const result = await invoke<boolean>("toggle_always_on_top");
      setIsPinned(result);
    } catch (e) {
      handleErrorSilent(e, "toggle pin");
    }
  }

  function handleRestore() {
    exitMiniMode();
  }

  function startDrag() {
    if (!isTauriReady()) return;
    getCurrentWindow().startDragging();
  }

  return (
    <div
      className="h-full flex flex-col select-none cursor-grab overflow-hidden"
      style={{
        background: "var(--app-glass-bg)",
        backdropFilter: "blur(var(--app-glass-blur-sm))",
        WebkitBackdropFilter: "blur(var(--app-glass-blur-sm))",
      }}
      onMouseDown={startDrag}
    >
      {/* 标题栏 */}
      <div
        className="flex justify-between items-center px-2 py-1 shrink-0"
        style={{ background: "var(--app-glass-bg-heavy)", borderBottom: "1px solid var(--app-glass-border)" }}
      >
        <span className="text-[11px] font-semibold" style={{ color: "var(--app-text-primary)" }}>
          CC-Panes
        </span>
        <div className="flex gap-0.5">
          <button
            className="flex items-center justify-center w-[18px] h-[18px] rounded-[3px] border-none cursor-pointer transition-all"
            style={{
              background: "transparent",
              color: isPinned ? "var(--app-accent)" : "var(--app-text-secondary)",
            }}
            onClick={(e) => { e.stopPropagation(); togglePin(); }}
            title={isPinned ? t("miniUnpin") : t("miniPin")}
          >
            <Pin size={10} className={isPinned ? "rotate-45" : ""} />
          </button>
          <button
            className="flex items-center justify-center w-[18px] h-[18px] rounded-[3px] border-none cursor-pointer transition-all hover:bg-[var(--app-hover)]"
            style={{ background: "transparent", color: "var(--app-text-secondary)" }}
            onClick={(e) => { e.stopPropagation(); handleRestore(); }}
            title={t("miniRestore")}
          >
            <Maximize2 size={10} />
          </button>
        </div>
      </div>

      {/* 状态网格 */}
      <div className="flex-1 grid grid-cols-2 gap-0.5 p-1 overflow-y-auto">
        {activeTabs.map((tab) => (
          <div
            key={tab.id}
            className="flex items-center gap-1 px-1.5 py-1 rounded cursor-pointer transition-colors hover:bg-[var(--app-active-bg)]"
            style={{ background: "var(--app-hover)" }}
            onDoubleClick={(e) => { e.stopPropagation(); handleRestore(); }}
          >
            <StatusIndicator status={getStatus(tab.sessionId)} size={8} />
            <span className="text-[10px] overflow-hidden text-ellipsis whitespace-nowrap" style={{ color: "var(--app-text-secondary)" }}>
              {tab.title}
            </span>
          </div>
        ))}
        {activeTabs.length === 0 && (
          <div className="col-span-2 flex items-center justify-center text-[11px] py-4" style={{ color: "var(--app-text-tertiary)" }}>
            {t("miniNoActiveSessions")}
          </div>
        )}
      </div>
    </div>
  );
}
