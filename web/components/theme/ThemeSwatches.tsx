import { Check, MonitorCog } from "lucide-react";
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

  // 迷你应用窗口：标题带 → 活动栏 → 主区，隐喻应用的明暗骨架（chrome 一档、内容一档）。
  // 明暗分层只用 swatches[0]/[1] 两档面色，文字条靠透明度混出中间调；accent 集中在
  // 窗口钮、活动栏激活项和主按钮三处，六张卡并排时强调色与层级对比一眼可辨。
  const [bg, surface, accent] = preset.swatches;

  return (
    <span
      className="relative block h-16 w-full overflow-hidden rounded-md border"
      style={{ background: bg, borderColor: surface }}
      aria-hidden="true"
    >
      <span className="flex h-2.5 items-center pl-1" style={{ background: surface }}>
        <span className="size-1 rounded-full" style={{ background: accent }} />
      </span>
      <span className="absolute bottom-0 left-0 top-2.5 w-2.5" style={{ background: surface }}>
        <span className="absolute left-1 top-1 h-2 w-0.5 rounded-full" style={{ background: accent }} />
      </span>
      <span className="absolute bottom-1.5 left-4 right-2 top-4 flex flex-col gap-1">
        <span className="h-1 w-9 rounded-full" style={{ background: surface }} />
        <span className="h-0.5 w-12 rounded-full opacity-60" style={{ background: surface }} />
        <span className="h-0.5 w-7 rounded-full opacity-40" style={{ background: surface }} />
        <span className="mt-auto h-1.5 w-5 rounded-sm" style={{ background: accent }} />
      </span>
    </span>
  );
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
