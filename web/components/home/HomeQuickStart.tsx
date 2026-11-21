// 首页「快速上手 已完成 x/5」：横排步骤条（参考 magpie 的内容，横排省纵向空间）。完成度与设置页清单共用 useSetupGuideItems。
// 全部完成或用户点 × 后整卡不再出现；关闭状态是本地 UI 偏好。
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronLeft, ChevronRight, GraduationCap, Play, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconTooltipButton } from "@/components/ui/IconTooltipButton";
import CliBrandIcon from "@/components/CliBrandIcon";
import { openGuideDoc } from "@/components/tips/openGuideDoc";
import { useDialogStore, useHomePreferencesStore } from "@/stores";
import type { CliToolInfo } from "@/types";
import { cn } from "@/lib/utils";
import { openOnboarding, useSetupGuideItems, type SetupGuideItem } from "@/components/onboarding/useSetupGuideItems";
import { openHomeCreateWorkspace, openHomeImportProject } from "./homeSetupDialogStore";

// 前两步在首页弹框里就地完成；其余步骤沿用共享清单的跳转。
const HOME_ACTIONS: Partial<Record<SetupGuideItem["id"], () => void>> = {
  workspace: openHomeCreateWorkspace,
  project: () => openHomeImportProject(),
};

interface HomeQuickStartProps {
  installedTools: readonly CliToolInfo[];
}

function StepMarker({ index, complete }: { index: number; complete: boolean }) {
  return complete ? (
    <span className="grid size-7 shrink-0 place-items-center rounded-full bg-[var(--app-status-success)] text-[var(--primary-foreground)]">
      <Check className="size-4" strokeWidth={3} aria-hidden="true" />
    </span>
  ) : (
    <span className="grid size-7 shrink-0 place-items-center rounded-full border-[1.5px] border-[var(--app-border)] text-[length:var(--text-small)] font-medium text-[var(--app-text-secondary)]">
      {index + 1}
    </span>
  );
}

export default function HomeQuickStart({ installedTools }: HomeQuickStartProps) {
  const { t } = useTranslation("home");
  const { t: tOnboarding } = useTranslation("onboarding");
  const dismissed = useHomePreferencesStore((s) => s.quickStartDismissed);
  const setDismissed = useHomePreferencesStore((s) => s.setQuickStartDismissed);
  const { items, completed, nextItem, skillCheckFailed } = useSetupGuideItems();
  // 用户点选/翻看的步骤；未选时停在第一个未完成项。
  const [selectedId, setSelectedId] = useState<SetupGuideItem["id"] | null>(null);

  if (dismissed || !nextItem) return null;

  const selectedIndex = Math.max(0, items.findIndex((item) => item.id === (selectedId ?? nextItem.id)));
  const selected = items[selectedIndex];
  const goTo = (index: number) => setSelectedId(items[index].id);

  const describe = (item: SetupGuideItem) =>
    item.id === "skill" && skillCheckFailed
      ? tOnboarding("setupGuide.items.skill.checkFailed")
      : tOnboarding(`setupGuide.items.${item.id}.description` as never);

  return (
    <section
      data-testid="home-quick-start"
      aria-label={t("quickStart.title")}
      className="rounded-2xl border border-[var(--app-home-border)] bg-[var(--app-home-surface)] px-5 py-4"
    >
      <header className="flex items-center gap-3">
        <h2 className="text-[length:var(--text-title)] font-semibold text-[var(--app-text-primary)]">
          {t("quickStart.title")}
        </h2>
        <span className="text-[length:var(--text-small)] tabular-nums text-[var(--app-text-tertiary)]">
          {t("quickStart.progress", { completed, total: items.length })}
        </span>
        <Button type="button" variant="ghost" size="sm" className="ml-auto gap-1.5" onClick={openOnboarding}>
          <Play className="size-3.5" aria-hidden="true" />
          {t("quickStart.tutorial")}
        </Button>
        <IconTooltipButton label={t("quickStart.dismiss")} onClick={() => setDismissed(true)} data-testid="home-quick-start-dismiss">
          <X className="size-4" aria-hidden="true" />
        </IconTooltipButton>
      </header>

      {/* 横排步骤：一行五格，省纵向空间；点格子或左右箭头翻看任一步（含已完成的），默认停在第一个未完成项 */}
      <ol className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {items.map((item, index) => {
          const isSelected = index === selectedIndex;
          return (
            <li key={item.id} className="min-w-0">
              <button
              type="button"
              data-step-id={item.id}
              data-complete={item.complete}
              aria-current={isSelected ? "step" : undefined}
              onClick={() => goTo(index)}
              className={cn(
                "flex w-full min-w-0 items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors duration-[var(--dur-fast)]",
                isSelected
                  ? "border-[color-mix(in_srgb,var(--app-accent)_45%,transparent)] bg-[var(--app-active-bg)]"
                  : "border-[var(--app-home-row-border)] hover:bg-[var(--app-home-surface-hover)]",
              )}
            >
              <StepMarker index={index} complete={item.complete} />
              <span
                className={cn(
                  "min-w-0 truncate text-[length:var(--text-small)] font-medium",
                  item.complete ? "text-[var(--app-text-tertiary)]" : "text-[var(--app-text-primary)]",
                )}
                title={tOnboarding(`setupGuide.items.${item.id}.title` as never)}
              >
                {tOnboarding(`setupGuide.items.${item.id}.title` as never)}
              </span>
              </button>
            </li>
          );
        })}
      </ol>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-0.5">
          <IconTooltipButton label={t("quickStart.prevStep")} disabled={selectedIndex === 0} onClick={() => goTo(selectedIndex - 1)}>
            <ChevronLeft className="size-4" aria-hidden="true" />
          </IconTooltipButton>
          <IconTooltipButton label={t("quickStart.nextStep")} disabled={selectedIndex === items.length - 1} onClick={() => goTo(selectedIndex + 1)}>
            <ChevronRight className="size-4" aria-hidden="true" />
          </IconTooltipButton>
        </div>
        <p className="min-w-0 flex-1 basis-64 text-[length:var(--text-small)] text-[var(--app-text-secondary)]">
          {describe(selected)}
        </p>
        {selected.id === "multiLaunch" && installedTools.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {installedTools.map((tool) => (
              <button
                key={tool.id}
                type="button"
                aria-label={t("quickStart.launchWith", { name: tool.displayName })}
                className="inline-flex h-8 items-center gap-1.5 rounded-full border border-[var(--app-border)] bg-[var(--app-content)] px-3 text-[length:var(--text-small)] text-[var(--app-text-primary)] transition-colors duration-[var(--dur-fast)] hover:border-[var(--app-home-border-hover)] hover:bg-[var(--app-home-surface-hover)]"
                onClick={() => useDialogStore.getState().openLauncher({ cliTool: tool.id })}
              >
                <CliBrandIcon cliTool={tool.id} className="size-3.5" />
                {tool.displayName}
              </button>
            ))}
          </div>
        )}
        <div className="flex items-center gap-1.5">
          <Button type="button" variant="ghost" size="sm" className="gap-1.5" onClick={() => void openGuideDoc(selected.guidePath)}>
            <GraduationCap className="size-3.5" aria-hidden="true" />
            {t("quickStart.viewGuide")}
          </Button>
          <Button type="button" size="sm" variant={selected.complete ? "outline" : "default"} onClick={HOME_ACTIONS[selected.id] ?? selected.action}>
            {tOnboarding(`setupGuide.items.${selected.id}.action` as never)}
          </Button>
        </div>
      </div>
    </section>
  );
}
