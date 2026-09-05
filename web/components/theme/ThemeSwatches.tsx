import { Check, MonitorCog } from "lucide-react";
import { MiniUiPreview } from "@/components/theme/MiniUiPreview";
import { cn } from "@/lib/utils";
import type { ThemePreset } from "@/theme/themePresets";

interface PresetSwatchesProps {
  preset: ThemePreset;
  size?: "menu" | "card";
}

export function PresetSwatches({ preset, size = "menu" }: PresetSwatchesProps) {
  if (size === "menu") {
    return (
      <span className="flex w-8 shrink-0 items-center" aria-hidden="true">
        <span
          className="size-3 rounded-full border border-black/10"
          style={{ background: preset.swatches[0] }}
        />
        <span
          className="-ml-0.5 size-3 rounded-full border border-black/10"
          style={{ background: preset.swatches[2] }}
        />
      </span>
    );
  }

  // 卡片缩略图：mini UI 具象渲染（主色带 + 侧栏 + Tab + 终端），色板由
  // MiniUiPreview 的 data-theme 作用域从该主题 token 解析，不再手绘色块。
  return <MiniUiPreview theme={preset.id} />;
}

interface SystemThemePreviewProps {
  selected?: boolean;
  className?: string;
}

export function SystemThemePreview({ selected = false, className }: SystemThemePreviewProps) {
  return (
    <span
      className={cn(
        "relative flex h-16 w-full items-center justify-center overflow-hidden rounded-md border border-[var(--app-border)]",
        className,
      )}
      style={{ background: "var(--app-content)" }}
      aria-hidden="true"
    >
      <span className="absolute inset-y-0 left-0 w-1/2" style={{ background: "var(--app-bg-deep)" }} />
      <span className="absolute inset-y-0 right-0 w-1/2" style={{ background: "var(--app-content)" }} />
      <MonitorCog className="relative size-4 text-[var(--app-text-secondary)]" />
      {selected && (
        <span className="absolute right-1 top-1 flex size-4 items-center justify-center rounded-full bg-[var(--app-accent)] text-white">
          <Check size={11} strokeWidth={3} />
        </span>
      )}
    </span>
  );
}
