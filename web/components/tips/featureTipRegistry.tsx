import type { ComponentType, ReactNode } from "react";
import {
  AppWindow,
  Command,
  LayoutGrid,
  Maximize2,
  Minimize2,
  Plus,
  Search,
  Terminal,
} from "lucide-react";
import { useShortcutsStore } from "@/stores";

export interface FeatureTipDefinition {
  id: string;
  actionId?: string;
  titleKey: string;
  bodyKey: string;
  bodyUnboundKey?: string;
  visual: ComponentType;
  tryAction?: () => void;
  eligible?: () => boolean;
  weight?: number;
}

function runShortcutAction(actionId: string): void {
  useShortcutsStore.getState().actions.get(actionId)?.handler();
}

function hasShortcutAction(actionId: string): boolean {
  return useShortcutsStore.getState().actions.has(actionId);
}

function VisualStage({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full min-h-[180px] items-center justify-center p-6 text-[var(--app-text-secondary)]">
      {children}
    </div>
  );
}

function CommandPaletteVisual() {
  return (
    <VisualStage>
      <div className="w-full max-w-[300px] overflow-hidden rounded-lg border border-[var(--app-border)] bg-[var(--app-content)] shadow-md">
        <div className="flex h-10 items-center gap-2 border-b border-[var(--app-border)] px-3 text-[var(--app-text-tertiary)]">
          <Search size={15} />
          <span className="h-1.5 w-28 rounded-full bg-[var(--app-hover)]" />
          <Command className="ml-auto text-[var(--app-accent)]" size={15} />
        </div>
        <div className="space-y-1.5 p-2">
          {["w-3/4", "w-2/3", "w-4/5"].map((width, index) => (
            <div
              key={width}
              className={`flex h-9 items-center gap-2 rounded-md px-2 ${index === 0 ? "bg-[var(--app-active-bg)] text-[var(--app-accent)]" : ""}`}
            >
              <span className="size-5 rounded border border-[var(--app-border)]" />
              <span className={`h-1.5 ${width} rounded-full bg-[var(--app-hover)]`} />
            </div>
          ))}
        </div>
      </div>
    </VisualStage>
  );
}

function LayoutSwitcherVisual() {
  return (
    <VisualStage>
      <div className="flex w-full max-w-[320px] flex-col gap-3">
        <div className="grid h-32 grid-cols-[1fr_1.35fr] gap-1.5 rounded-lg border border-[var(--app-accent)] bg-[var(--app-content)] p-2 shadow-md">
          <span className="rounded-md bg-[var(--app-active-bg)]" />
          <span className="grid grid-rows-2 gap-1.5">
            <span className="rounded-md border border-[var(--app-border)]" />
            <span className="rounded-md border border-[var(--app-border)]" />
          </span>
        </div>
        <div className="flex justify-center gap-2">
          {[0, 1, 2].map((index) => (
            <span
              key={index}
              className={`flex size-9 items-center justify-center rounded-md border ${index === 0 ? "border-[var(--app-accent)] bg-[var(--app-active-bg)] text-[var(--app-accent)]" : "border-[var(--app-border)] bg-[var(--app-content)]"}`}
            >
              <LayoutGrid size={15} />
            </span>
          ))}
        </div>
      </div>
    </VisualStage>
  );
}

function MiniModeVisual() {
  return (
    <VisualStage>
      <div className="flex items-center gap-4">
        <div className="relative h-36 w-48 rounded-lg border border-[var(--app-border)] bg-[var(--app-content)] p-2 shadow-md">
          <div className="flex h-full gap-2">
            <span className="w-8 rounded-md bg-[var(--app-active-bg)]" />
            <span className="flex-1 rounded-md border border-[var(--app-border)] bg-[var(--app-terminal-bg)]" />
          </div>
          <Minimize2 className="absolute right-3 top-3 text-[var(--app-accent)]" size={16} />
        </div>
        <Maximize2 className="text-[var(--app-text-tertiary)] motion-safe:animate-pulse motion-reduce:animate-none" size={18} />
        <div className="flex h-28 w-20 items-center justify-center rounded-lg border border-[var(--app-accent)] bg-[var(--app-terminal-bg)] shadow-md">
          <Terminal className="text-[var(--app-accent)]" size={19} />
        </div>
      </div>
    </VisualStage>
  );
}

function LauncherVisual() {
  return (
    <VisualStage>
      <div className="w-full max-w-[310px] rounded-lg border border-[var(--app-border)] bg-[var(--app-content)] p-3 shadow-md">
        <div className="mb-3 flex items-center gap-2 text-[var(--app-accent)]">
          <Plus size={16} />
          <span className="h-1.5 w-24 rounded-full bg-[var(--app-active-bg)]" />
        </div>
        <div className="grid grid-cols-2 gap-2">
          {[Terminal, AppWindow, Command, LayoutGrid].map((Icon, index) => (
            <div
              key={index}
              className={`flex h-16 items-center gap-2 rounded-md border px-3 ${index === 0 ? "border-[var(--app-accent)] bg-[var(--app-active-bg)] text-[var(--app-accent)]" : "border-[var(--app-border)]"}`}
            >
              <Icon size={16} />
              <span className="h-1.5 flex-1 rounded-full bg-[var(--app-hover)]" />
            </div>
          ))}
        </div>
      </div>
    </VisualStage>
  );
}

function shortcutTip(
  definition: Omit<FeatureTipDefinition, "tryAction" | "eligible"> & { actionId: string },
): FeatureTipDefinition {
  return {
    ...definition,
    tryAction: () => runShortcutAction(definition.actionId),
    eligible: () => hasShortcutAction(definition.actionId),
  };
}

export const FEATURE_TIPS: readonly FeatureTipDefinition[] = [
  shortcutTip({
    id: "command-palette",
    actionId: "command-palette",
    titleKey: "featureTips.commandPalette.title",
    bodyKey: "featureTips.commandPalette.body",
    bodyUnboundKey: "featureTips.commandPalette.bodyUnbound",
    visual: CommandPaletteVisual,
    weight: 3,
  }),
  shortcutTip({
    id: "layout-switcher",
    actionId: "toggle-layouts",
    titleKey: "featureTips.layoutSwitcher.title",
    bodyKey: "featureTips.layoutSwitcher.body",
    bodyUnboundKey: "featureTips.layoutSwitcher.bodyUnbound",
    visual: LayoutSwitcherVisual,
    weight: 2,
  }),
  shortcutTip({
    id: "mini-mode",
    actionId: "toggle-mini-mode",
    titleKey: "featureTips.miniMode.title",
    bodyKey: "featureTips.miniMode.body",
    bodyUnboundKey: "featureTips.miniMode.bodyUnbound",
    visual: MiniModeVisual,
    weight: 1,
  }),
  shortcutTip({
    id: "unified-launcher",
    actionId: "new-tab",
    titleKey: "featureTips.launcher.title",
    bodyKey: "featureTips.launcher.body",
    bodyUnboundKey: "featureTips.launcher.bodyUnbound",
    visual: LauncherVisual,
    weight: 2,
  }),
];
