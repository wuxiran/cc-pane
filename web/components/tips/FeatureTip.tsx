import { Check, Keyboard, Play } from "lucide-react";
import { useTranslation } from "react-i18next";
import GuidedDialog from "@/components/onboarding/GuidedDialog";
import { Button } from "@/components/ui/button";
import { formatKeyCombo, isTerminalPassthroughAction, useSettingsStore } from "@/stores";
import type { FeatureTipDefinition } from "./featureTipRegistry";

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

  return (
    <GuidedDialog
      open
      onOpenChange={(open) => {
        if (!open) onDismiss();
      }}
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
        <div className="flex w-full flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onDismiss}>
            <Check aria-hidden="true" size={15} />
            {t("featureTips.gotIt")}
          </Button>
          {definition.tryAction && (
            <Button onClick={onTry}>
              <Play aria-hidden="true" size={15} />
              {t("featureTips.try")}
            </Button>
          )}
        </div>
      )}
    >
      <div className="space-y-4">
        <span className="inline-flex rounded-md border border-[var(--app-accent)] px-2 py-1 text-[11px] font-semibold text-[var(--app-accent)]">
          {t("featureTips.badge")}
        </span>
        {showPassthroughHint && (
          <p
            className="text-[12px] leading-relaxed text-[var(--app-text-secondary)]"
            data-testid="feature-tip-passthrough-hint"
          >
            {t("featureTips.terminalPassthroughHint")}
          </p>
        )}
        <button
          type="button"
          className="flex items-center gap-2 text-left text-[12px] text-[var(--app-text-secondary)] hover:text-[var(--app-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]"
          onClick={onOpenShortcuts}
        >
          <Keyboard aria-hidden="true" size={15} />
          <span>
            {t("featureTips.rebind")} <span className="text-[var(--app-accent)]">{t("featureTips.shortcutSettings")}</span>
          </span>
        </button>
        <button
          type="button"
          className="text-left text-[11px] text-[var(--app-text-tertiary)] hover:text-[var(--app-text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]"
          onClick={onDisable}
        >
          {t("featureTips.disable")}
        </button>
      </div>
    </GuidedDialog>
  );
}
