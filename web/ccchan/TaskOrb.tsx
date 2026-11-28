// 任务球本体：外圈按会话分段着色，中心是「等你回复 + 出错」数（0 时显示网格图标）。
import type { PointerEvent, WheelEvent } from "react";
import { useTranslation } from "react-i18next";
import { LayoutGrid } from "lucide-react";
import { ORB_SIZE, type OrbCenter } from "./orbModel";

const TONE_COLOR = {
  warning: "var(--app-status-warning)",
  danger: "var(--app-status-danger)",
} as const;

/** 外圈宽度：conic-gradient 铺满整个圆，中心盖一层核心盘。 */
const RING_WIDTH = 5;

interface TaskOrbProps {
  x: number;
  y: number;
  ring: string;
  center: OrbCenter;
  /** 有等你回复且列表未展开时外圈慢脉冲。 */
  pulse: boolean;
  onPointerDown: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerMove: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerCancel: () => void;
  onPointerEnter: () => void;
  onWheel: (event: WheelEvent<HTMLButtonElement>) => void;
}

export function TaskOrb({ x, y, ring, center, pulse, onWheel, onPointerEnter, ...gesture }: TaskOrbProps) {
  const { t } = useTranslation("ccchan");
  return (
    <button
      type="button"
      data-pet-hit=""
      data-testid="task-orb"
      aria-label={t("orb.label")}
      className="absolute rounded-full p-0 shadow-lg outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]"
      style={{
        left: x,
        top: y,
        width: ORB_SIZE,
        height: ORB_SIZE,
        background: ring,
        opacity: center.calm ? 0.6 : 1,
        cursor: "default",
      }}
      onClick={(event) => event.stopPropagation()}
      onPointerEnter={onPointerEnter}
      onWheel={onWheel}
      {...gesture}
    >
      {pulse && (
        <span
          data-testid="task-orb-pulse"
          aria-hidden="true"
          className="ccchan-orb-halo pointer-events-none absolute inset-0 rounded-full border-2"
          style={{ borderColor: TONE_COLOR.warning }}
        />
      )}
      <span
        className="pointer-events-none absolute grid place-items-center rounded-full border"
        style={{ inset: RING_WIDTH, background: "var(--popover)", borderColor: "var(--border)" }}
      >
        {center.tone ? (
          <span className="flex flex-col items-center leading-none">
            <b data-testid="task-orb-count" className="text-[18px] font-semibold" style={{ color: TONE_COLOR[center.tone] }}>
              {center.count > 99 ? "99+" : center.count}
            </b>
            <small className="mt-0.5 text-[9px]" style={{ color: "var(--app-text-tertiary)" }}>
              {t("orb.waiting")}
            </small>
          </span>
        ) : (
          <LayoutGrid size={18} aria-hidden="true" style={{ color: "var(--app-text-secondary)" }} />
        )}
      </span>
    </button>
  );
}
