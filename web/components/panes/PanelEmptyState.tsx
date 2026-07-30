// 窗格空态整块（图标 + 标题 + 说明 + 启动动作）。
// 从 Panel.tsx 拆出：Panel.tsx 已触到行数棘轮上限（web/test/lineRatchet.test.ts），
// 空态是它最自成一体的一块，先拆这块。
//
// 两个设计点写在 emptyStateShared.tsx 的文件头：
//   1. 密度分档按**窗格宽度**（空态是 absolute inset-0，窗格可以被拖到很窄）
//   2. 壁纸激活时内容块自带底（--app-panel-bg-effective 在壁纸下恒为 transparent）
import { Terminal } from "lucide-react";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation("panes");
  const { attachRef, density } = useEmptyStateDensity<HTMLDivElement>();
  const surfaceStyle = useEmptyStateSurfaceStyle();

  return (
    <div
      ref={attachRef}
      className="absolute inset-0 flex flex-col items-center justify-center select-none overflow-hidden"
      style={{ background: "var(--app-panel-bg-effective)", paddingTop: tabBarHeight }}
    >
      {/* 点阵背景（opacity 走壁纸 token，壁纸激活时可整体压 0） */}
      <div
        className="absolute inset-0"
        style={{
          opacity: "var(--app-panel-dots-opacity)",
          backgroundImage: "radial-gradient(var(--app-text-primary) 1px, transparent 1px)",
          backgroundSize: "24px 24px",
        }}
      />

      {/* 内容块 — 壁纸激活时自带不透明底，否则文字直接糊在壁纸上读不出。
          只包内容不铺满窗格：铺满会盖掉壁纸，那正是壁纸要透出来的地方。 */}
      <div
        data-testid="panel-empty-content"
        data-density={density}
        className="relative flex max-h-full w-full flex-col items-center overflow-y-auto"
        style={
          surfaceStyle
            ? {
                ...surfaceStyle,
                width: "auto",
                maxWidth: "calc(100% - 24px)",
                padding: density === "full" ? "24px 8px" : "14px 8px",
              }
            : undefined
        }
      >
        {/* 图标容器 — 窄窗格里是纯装饰，先砍它 */}
        {density === "full" && (
          <div
            className="relative w-20 h-20 rounded-2xl flex items-center justify-center mb-6 transition-transform duration-700"
            style={{
              background: "color-mix(in srgb, var(--app-accent) 8%, var(--app-hover))",
              border: "1px solid var(--app-border)",
              boxShadow: "var(--sh-md), var(--hi)",
            }}
          >
            <Terminal className="w-9 h-9" style={{ color: "var(--app-accent)", opacity: 0.85 }} />
          </div>
        )}

        {density !== "mini" && (
          <h3
            className={
              density === "full"
                ? "text-lg font-semibold mb-2 tracking-tight"
                : "text-[13px] font-semibold tracking-tight"
            }
            style={{ color: "var(--app-text-primary)" }}
          >
            {t("ready")}
          </h3>
        )}
        {density === "full" && (
          <p
            className="text-center max-w-sm leading-relaxed text-[13px]"
            style={{ color: "var(--app-text-tertiary)" }}
          >
            {t("selectProject")}
          </p>
        )}
        <PanelEmptyActions pane={pane} density={density} />
      </div>
    </div>
  );
}
