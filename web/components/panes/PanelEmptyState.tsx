// 窗格空态整块（容器 + 密度分档）；标题与启动动作在 PanelEmptyActions / WorkspaceEmptyActions。
// 从 Panel.tsx 拆出：Panel.tsx 已触到行数棘轮上限（web/test/lineRatchet.test.ts），
// 空态是它最自成一体的一块，先拆这块。
//
// 两个设计点写在 emptyStateShared.tsx 的文件头：
//   1. 密度分档按**窗格宽度**（空态是 absolute inset-0，窗格可以被拖到很窄）
//   2. 壁纸激活时内容块自带底（--app-panel-bg-effective 在壁纸下恒为 transparent）
import PanelEmptyActions from "./PanelEmptyActions";
import { useEmptyStateDensity, useEmptyStateSurfaceStyle } from "./emptyStateShared";
import type { Panel as PanelType } from "@/types";

export default function PanelEmptyState({
  pane,
  tabBarHeight,
}: {
  pane: PanelType;
  tabBarHeight: number;
}) {
  const { attachRef, density } = useEmptyStateDensity<HTMLDivElement>();
  const surfaceStyle = useEmptyStateSurfaceStyle();

  return (
    <div
      ref={attachRef}
      className="absolute inset-0 flex flex-col items-center justify-center select-none overflow-hidden"
      style={{ background: "var(--app-panel-bg-effective)", paddingTop: tabBarHeight }}
    >
      {/* 不铺点阵背景：原生空态是素底 + 图标 + 一行字（docs/46 原生手感），点阵是网页式装饰，
          且 inset-0 会延伸到标签条下面。 */}

      {/* 内容块 — 左对齐、限宽，与新标签页（NewTabPage）同一版式：标题 → 开始 → 最近。
          壁纸激活时自带磨砂玻璃底，否则文字直接糊在壁纸上读不出；只包内容不铺满窗格。 */}
      <div
        data-testid="panel-empty-content"
        data-density={density}
        className={`relative flex max-h-full w-full max-w-[600px] flex-col overflow-y-auto ${
          density === "full" ? "px-8 py-6" : "px-4 py-4"
        }`}
        style={surfaceStyle ? { ...surfaceStyle, maxWidth: "min(600px, calc(100% - 24px))" } : undefined}
      >
        <PanelEmptyActions pane={pane} density={density} />
      </div>
    </div>
  );
}
