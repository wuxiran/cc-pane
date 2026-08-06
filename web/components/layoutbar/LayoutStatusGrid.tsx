import { Circle, Diamond, Triangle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { TERMINAL_STATUS_PRESENTATION } from "@/lib/statusPresentation";
import type { LayoutStatusSummary } from "./layoutStatusSummary";
import type { LucideIcon } from "lucide-react";
import type { TerminalStatusType } from "@/types";

// 单行状态桁：每个非零桶渲染「形状 + 颜色 + 数字」三重编码。
//
// 为什么不是原来的 2×2 同形圆点：四个槽位形状完全一致时，危险/等授权/运行/空闲
// 只能靠颜色区分，色盲用户与灰度截图下完全不可读，冗余仅有 hover 才出的 title。
// docs/46-frontend-styleguide.md:54 明确要求「等待输入使用琥珀且必须有形状或文字
// 冗余表达」。形状用 lucide 而非 Unicode 字符——▲◆◉○ 的字形宽度跨平台不可控。
//
// 色 token 不变，仍是 styleguide 第 3 节的四分类：idle 用中性 tertiary 而非
// success —— 空闲是中性事实，不是好消息。
// 零值桶不渲染（不再占位），所以无告警时这一桁自然收敛成两个符号。
const CELLS = [
  {
    key: "blocked",
    status: "error",
  },
  {
    key: "waitingInput",
    status: "waitingInput",
  },
  {
    key: "running",
    status: "active",
  },
  {
    key: "idle",
    status: "idle",
  },
] as const satisfies readonly { key: keyof Omit<LayoutStatusSummary, "total">; status: TerminalStatusType }[];

const SHAPE_ICON: Record<NonNullable<(typeof TERMINAL_STATUS_PRESENTATION)[TerminalStatusType]["shape"]>, LucideIcon> = {
  circle: Circle,
  diamond: Diamond,
  triangle: Triangle,
};

export default function LayoutStatusGrid({ summary }: { summary: LayoutStatusSummary }) {
  const { t } = useTranslation("dialogs");
  if (summary.total === 0) return null;

  return (
    <span className="flex shrink-0 items-center gap-1.5" data-testid="layout-status-row">
      {CELLS.map((cell) => {
        const count = summary[cell.key];
        if (count === 0) return null;
        const presentation = TERMINAL_STATUS_PRESENTATION[cell.status];
        const Icon = SHAPE_ICON[presentation.shape ?? "circle"];
        const filled = presentation.filled ?? true;
        // title 只给状态名——数字就在旁边，重复一遍是噪音；
        // aria-label 才带计数，屏幕阅读器读不到那个视觉上的相邻关系。
        const name = t(presentation.labelKey);
        return (
          <span
            key={cell.key}
            title={name}
            aria-label={`${count} ${name}`}
            data-status-cell={cell.key}
            className="flex items-center gap-0.5"
            style={{ color: presentation.colorToken }}
          >
            <Icon
              aria-hidden
              className="size-[9px] shrink-0"
              strokeWidth={filled ? 1 : 2.5}
              fill={filled ? "currentColor" : "none"}
            />
            <span className="text-[11px] leading-none tabular-nums">{count}</span>
          </span>
        );
      })}
    </span>
  );
}
