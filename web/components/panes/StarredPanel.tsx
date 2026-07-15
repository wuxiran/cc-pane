import { useMemo } from "react";
import { Star } from "lucide-react";
import { useTranslation } from "react-i18next";
import { usePanesStore } from "@/stores";
import { collectPanels } from "@/stores/paneTreeHelpers";
import type { LayoutEntry, PaneNode } from "@/types";
import StarredMirrorGrid from "./StarredMirrorGrid";
import type { StarredShortcutSource } from "./starredMirrors";

function collectStarredTabs(rootPane: PaneNode, layouts: LayoutEntry[], currentLayoutId: string): StarredShortcutSource[] {
  const shortcuts: StarredShortcutSource[] = [];

  for (const layout of layouts) {
    if (layout.kind === "starred") continue;
    const tree = layout.id === currentLayoutId ? rootPane : layout.rootPane;
    for (const panel of collectPanels(tree)) {
      for (const tab of panel.tabs) {
        if (tab.starred) {
          shortcuts.push({
            layoutId: layout.id,
            layoutName: layout.name,
            paneId: panel.id,
            tab,
          });
        }
      }
    }
  }

  return shortcuts;
}

export default function StarredPanel() {
  const { t } = useTranslation("panes");
  const rootPane = usePanesStore((s) => s.rootPane);
  const layouts = usePanesStore((s) => s.layouts);
  const currentLayoutId = usePanesStore((s) => s.currentLayoutId);
  const starredTabs = useMemo(
    () => collectStarredTabs(rootPane, layouts, currentLayoutId),
    [rootPane, layouts, currentLayoutId],
  );
  const openStarredTab = usePanesStore((s) => s.openStarredTab);

  return (
    <div className="flex h-full min-h-0 w-full flex-col" style={{ background: "var(--app-panel-bg)", color: "var(--app-text-primary)" }}>
      <div className="flex h-12 shrink-0 items-center gap-2 border-b px-4" style={{ borderColor: "var(--app-border)" }}>
        <Star className="h-4 w-4" fill="currentColor" style={{ color: "var(--app-accent)" }} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{t("starredPanelTitle")}</div>
          <div className="truncate text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
            {t("starredPanelCount", { count: starredTabs.length })}
          </div>
        </div>
      </div>

      {starredTabs.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <div
            className="flex h-12 w-12 items-center justify-center rounded-md border"
            style={{ borderColor: "var(--app-border)", color: "var(--app-text-tertiary)" }}
          >
            <Star className="h-5 w-5" />
          </div>
          <div className="max-w-sm text-sm" style={{ color: "var(--app-text-secondary)" }}>
            {t("starredPanelEmpty")}
          </div>
        </div>
      ) : (
        // 镜像网格：每个星标终端挂同一 PTY 会话的第二视图，与原布局实时同步
        <StarredMirrorGrid shortcuts={starredTabs} onJump={openStarredTab} />
      )}
    </div>
  );
}
