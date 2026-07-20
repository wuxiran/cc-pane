// 壁纸滑杆行：全局设置（WallpaperSection）与工作空间覆盖（WorkspaceWallpaperCard）
// 共用同一个渲染，避免两处滑杆样式/取值范围各写一份而漂移。
import { Label } from "@/components/ui/label";

export interface WallpaperSliderRowProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
  disabled?: boolean;
  /** 滑杆宽度：工作空间卡片比设置面板窄 */
  className?: string;
}

export const formatPercent = (value: number) => `${Math.round(value * 100)}%`;

export default function WallpaperSliderRow({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
  disabled = false,
  className = "w-48",
}: WallpaperSliderRowProps) {
  return (
    <div className="flex items-center justify-between gap-3">
      <Label>{label}</Label>
      <div className="flex items-center gap-3">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          className={`${className} cursor-pointer disabled:cursor-not-allowed disabled:opacity-50`}
          style={{ accentColor: "var(--app-accent)" }}
          onChange={(event) => onChange(Number(event.target.value))}
        />
        <span
          className="w-12 text-right font-mono text-[12px]"
          style={{ color: "var(--app-text-secondary)" }}
        >
          {format(value)}
        </span>
      </div>
    </div>
  );
}
