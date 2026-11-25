// 会话卡右上角的状态：形状（圆/菱形/三角）+ 实心/空心 + 颜色 + 状态词，
// 三重冗余，色弱和灰度下也分得清（statusPresentation 是唯一真源）。
import { getStatusPresentation, type StatusPresentationShape } from "@/lib/statusPresentation";
import type { TerminalStatusType } from "@/types";

interface Props {
  status: TerminalStatusType | null;
  label: string;
  /** 只显示形状（窄空间或常规态），状态词仍在 aria/tooltip 里 */
  compact?: boolean;
  /**
   * 覆盖由 status 推出的外观。任务视图用：「完成」是 idle + 未看标记，按 idle 画会是
   * 灰色空心圈，与「已结束」分不开。
   */
  appearance?: StatusGlyphAppearance;
}

export interface StatusGlyphAppearance {
  colorToken: string;
  shape: StatusPresentationShape;
  filled: boolean;
}

const SIZE = 8;

function Shape({ shape, filled, color }: { shape: string; filled: boolean; color: string }) {
  const fill = filled ? color : "none";
  const stroke = color;
  if (shape === "diamond") {
    return <path d="M4 0.6 7.4 4 4 7.4 0.6 4Z" fill={fill} stroke={stroke} strokeWidth="1.2" />;
  }
  if (shape === "triangle") {
    return <path d="M4 0.7 7.5 7.2H0.5Z" fill={fill} stroke={stroke} strokeWidth="1.2" strokeLinejoin="round" />;
  }
  return <circle cx="4" cy="4" r="3.2" fill={fill} stroke={stroke} strokeWidth="1.2" />;
}

export default function SessionStatusGlyph({ status, label, compact = false, appearance }: Props) {
  const base = getStatusPresentation(status);
  const presentation = appearance ? { pulsing: false, ...appearance } : base;
  if (!presentation) return null;
  const color = presentation.colorToken;
  return (
    <span
      className="inline-flex min-w-0 shrink items-center gap-1"
      data-status={status ?? undefined}
      data-shape={presentation.shape ?? "circle"}
      title={label || undefined}
    >
      <svg
        width={SIZE}
        height={SIZE}
        viewBox="0 0 8 8"
        aria-hidden="true"
        className={`shrink-0 ${presentation.pulsing ? "cc-status-pulse" : ""}`}
      >
        <Shape shape={presentation.shape ?? "circle"} filled={presentation.filled ?? true} color={color} />
      </svg>
      {!compact && label && (
        <span className="truncate text-[length:var(--text-micro)] leading-none" style={{ color }}>
          {label}
        </span>
      )}
    </span>
  );
}
