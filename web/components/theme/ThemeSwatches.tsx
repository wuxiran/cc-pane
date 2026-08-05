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

  return (
    <span
      className="relative block h-12 w-full overflow-hidden rounded-md border"
      style={{ background: preset.swatches[0], borderColor: preset.swatches[1] }}
      aria-hidden="true"
    >
      <span className="absolute inset-y-0 left-0 w-3" style={{ background: preset.swatches[2] }} />
      <span className="absolute inset-y-1.5 left-4 right-1.5 rounded-sm" style={{ background: preset.swatches[1] }}>
        <span className="absolute left-2 top-2 h-0.5 w-6 rounded-full" style={{ background: preset.swatches[2] }} />
        <span className="absolute left-2 top-4 h-0.5 w-4 rounded-full opacity-70" style={{ background: preset.swatches[2] }} />
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
        "relative flex h-12 w-full items-center justify-center overflow-hidden rounded-md border border-[var(--app-border)]",
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
