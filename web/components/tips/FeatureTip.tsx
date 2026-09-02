// tip 弹窗左栏结构（docs/46 §6.1）：TIP 徽标为标题上方 eyebrow；
// 教程 / 改绑收进「了解更多」分组面板，passthrough 警示以琥珀底贴面板尾部——
// 三类次要信息一处收纳，全部缺席时面板整个不渲染；
// 「不再显示任何提示」在 footer 左下角与主按钮对角呼应。dismiss/disable 语义与计数不变。
import { BookOpen, Check, Keyboard, Play, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import GuidedDialog from "@/components/onboarding/GuidedDialog";
import { Button } from "@/components/ui/button";
import { formatKeyCombo, isTerminalPassthroughAction, useSettingsStore } from "@/stores";
import type { FeatureTipDefinition } from "./featureTipRegistry";
import { openGuideDoc } from "./openGuideDoc";

interface FeatureTipProps {
  definition: FeatureTipDefinition;
  onTry: () => void;
  onDismiss: () => void;
  onDisable: () => void;
  onOpenShortcuts: () => void;
}

export default function FeatureTip({
  definition,
  onTry,
  onDismiss,
  onDisable,
  onOpenShortcuts,
}: FeatureTipProps) {
  const { t } = useTranslation("settings");
  const binding = useSettingsStore((state) =>
    definition.actionId ? state.settings?.shortcuts.bindings[definition.actionId] ?? "" : "",
  );
  const formattedBinding = binding ? formatKeyCombo(binding) : null;
  const bodyKey = formattedBinding || !definition.bodyUnboundKey
    ? definition.bodyKey
    : definition.bodyUnboundKey;
  const Visual = definition.visual;
  // 限制说明从 TERMINAL_PASSTHROUGH_ACTIONS 派生，放行清单变了文案自动跟着变。
  // 与"未绑定"降级正交：没绑定就谈不上被终端吃掉，此时不显示。
  const showPassthroughHint = Boolean(
    formattedBinding && definition.actionId && isTerminalPassthroughAction(definition.actionId),
  );
  const hasMorePanel = Boolean(definition.guidePath || definition.actionId || showPassthroughHint);

  return (
    <GuidedDialog
      open
      onOpenChange={(open) => {
        if (!open) onDismiss();
      }}
      nav={(
        <span className="mb-3 inline-flex rounded-full border border-[var(--app-accent)] px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--app-accent)]">
          {t("featureTips.badge")}
        </span>
      )}
      title={(
        <span className="flex flex-wrap items-center gap-2 text-[18px]">
          <span>{t(definition.titleKey as never)}</span>
          {formattedBinding && (
            <kbd className="rounded-md border border-[var(--app-border)] bg-[var(--app-panel-bg)] px-2 py-1 font-mono text-[11px] font-medium text-[var(--app-text-secondary)]">
              {formattedBinding}
            </kbd>
          )}
        </span>
      )}
      description={t(bodyKey as never)}
      visual={<Visual />}
      footer={(
        <div className="flex w-full flex-wrap items-center gap-2">
          <button
            type="button"
            className="text-left text-[11px] text-[var(--app-text-tertiary)] hover:text-[var(--app-text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]"
            onClick={onDisable}
          >
            {t("featureTips.disable")}
          </button>
          <span className="min-w-2 flex-1" />
          <Button variant="outline" onClick={onDismiss}>
            <Check aria-hidden="true" size={15} />
            {t("featureTips.gotIt")}
          </Button>
          {definition.tryAction && (
            <Button onClick={onTry}>
              <Play aria-hidden="true" size={15} />
              {t((definition.actionLabelKey ?? "featureTips.try") as never)}
            </Button>
          )}
        </div>
      )}
    >
      {hasMorePanel && (
        <div className="overflow-hidden rounded-lg bg-[var(--app-panel-bg)]">
          {definition.guidePath && (
            <button
              type="button"
              data-testid="feature-tip-guide-link"
              className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-[12px] text-[var(--app-text-secondary)] hover:bg-[var(--app-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--app-accent)]"
              onClick={() => void openGuideDoc(definition.guidePath!)}
            >
              <BookOpen aria-hidden="true" size={15} />
              <span className="text-[var(--app-accent)]">{t("featureTips.learnMore")}</span>
            </button>
          )}
          {definition.actionId && (
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-[12px] text-[var(--app-text-secondary)] hover:bg-[var(--app-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--app-accent)]"
              onClick={onOpenShortcuts}
            >
              <Keyboard aria-hidden="true" size={15} />
              <span>
                {t("featureTips.rebind")} <span className="text-[var(--app-accent)]">{t("featureTips.shortcutSettings")}</span>
              </span>
            </button>
          )}
          {showPassthroughHint && (
            <p
              className="flex items-start gap-2 bg-[var(--app-status-warning-bg)] px-3 py-2.5 text-[12px] leading-relaxed text-[var(--app-text-secondary)]"
              data-testid="feature-tip-passthrough-hint"
            >
              <TriangleAlert aria-hidden="true" size={14} className="mt-0.5 shrink-0 text-[var(--app-status-warning)]" />
              <span>{t("featureTips.terminalPassthroughHint")}</span>
            </p>
          )}
        </div>
      )}
    </GuidedDialog>
  );
}
