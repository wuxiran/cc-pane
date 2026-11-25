// ChatModelPicker 的子块：左栏引擎图标轨、中栏模型行、右栏推理档位。纯展示，状态在父组件。
import { Check, Star, Store } from "lucide-react";
import { useTranslation } from "react-i18next";
import { CommandItem, CommandShortcut } from "@/components/ui/command";
import { IconTooltipButton } from "@/components/ui/IconTooltipButton";
import { cn } from "@/lib/utils";
import ChatEngineIcon from "./ChatEngineIcon";
import { FAVORITES_RAIL, rowKey, type EffortControl, type PickerModelRow } from "./chatModelPickerModel";

export interface PickerEngine {
  id: string;
  label: string;
  available: boolean;
  requirement?: string;
}

export function PickerRail({
  engines, browse, currentEngineId, onBrowse, onBrowseRegistry,
}: {
  engines: readonly PickerEngine[];
  browse: string;
  currentEngineId: string | null;
  onBrowse: (id: string) => void;
  onBrowseRegistry?: () => void;
}) {
  const { t } = useTranslation("panes");
  const railButton = (id: string, label: string, icon: React.ReactNode, dim = false) => (
    <div key={id} className="relative flex w-full justify-center">
      {id === currentEngineId ? (
        <span aria-hidden="true" data-testid="model-picker-current-engine"
          className="absolute bottom-1.5 left-0 top-1.5 w-[3px] rounded-r bg-[var(--app-accent)]" />
      ) : null}
      <IconTooltipButton
        label={label}
        side="left"
        aria-pressed={browse === id}
        data-rail-id={id}
        className={cn("size-8", browse === id && "bg-[var(--app-active-bg)] text-[var(--app-text-primary)]", dim && "opacity-50")}
        onClick={() => onBrowse(id)}
      >
        {icon}
      </IconTooltipButton>
    </div>
  );
  return (
    <div className="flex w-11 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-[var(--app-border)] py-2">
      {railButton(FAVORITES_RAIL, t("agentChatModelFavorites"), <Star className="size-4" />)}
      <span aria-hidden="true" className="my-0.5 h-px w-5 bg-[var(--app-border)]" />
      {engines.map((engine) => railButton(
        engine.id,
        engine.available ? engine.label : `${engine.label} · ${engine.requirement || t("agentChatUnavailableEngine")}`,
        <ChatEngineIcon engineId={engine.id} className="size-4" />,
        !engine.available,
      ))}
      {onBrowseRegistry ? (
        <IconTooltipButton label={t("acpRegistry.browse")} side="left" className="mt-auto size-8" onClick={onBrowseRegistry}>
          <Store className="size-4" />
        </IconTooltipButton>
      ) : null}
    </div>
  );
}

export function PickerModelItem({
  row, current, disabled, favorite, shortcut, title, onPick, onToggleFavorite,
}: {
  row: PickerModelRow;
  current: boolean;
  disabled: boolean;
  favorite: boolean;
  shortcut: string | null;
  title?: string;
  onPick: () => void;
  onToggleFavorite: () => void;
}) {
  const { t } = useTranslation("panes");
  return (
    <CommandItem
      value={rowKey(row)}
      disabled={disabled}
      title={title ?? row.description}
      data-current={current || undefined}
      onSelect={onPick}
      className="group gap-2 px-2 py-1.5"
    >
      <ChatEngineIcon engineId={row.engineId} className="size-3.5" />
      <span className="min-w-0 flex-1 truncate">{row.label}</span>
      {row.modelId !== null ? (
        <button
          type="button"
          aria-label={t(favorite ? "agentChatModelUnfavorite" : "agentChatModelFavorite")}
          aria-pressed={favorite}
          className={cn(
            "inline-flex size-5 shrink-0 items-center justify-center rounded text-[var(--app-text-tertiary)] hover:text-[var(--app-text-primary)] focus-visible:opacity-100",
            favorite ? "text-[var(--app-accent)] opacity-100" : "opacity-0 group-hover:opacity-100 group-data-[selected=true]:opacity-100",
          )}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onToggleFavorite();
          }}
        >
          <Star className={cn("!size-3.5", favorite && "!text-[var(--app-accent)]")} fill={favorite ? "currentColor" : "none"} />
        </button>
      ) : null}
      {current ? <Check aria-label={t("agentChatModelCurrent")} className="!size-3.5 !text-[var(--app-text-primary)]" /> : null}
      {shortcut ? <CommandShortcut className="ml-0">{shortcut}</CommandShortcut> : null}
    </CommandItem>
  );
}

export function PickerEffortColumn({
  modelLabel, effort, note, onPick,
}: {
  modelLabel: string;
  effort: EffortControl | null;
  /** 没有档位时的说明；缺省为「此模型不支持」。 */
  note?: string;
  onPick?: (value: string) => void;
}) {
  const { t } = useTranslation("panes");
  return (
    <div className="flex w-36 shrink-0 flex-col border-l border-[var(--app-border)]">
      <div className="border-b border-[var(--app-border)] px-3 py-2">
        <div className="text-[length:var(--text-micro)] font-semibold uppercase tracking-wider text-[var(--app-text-tertiary)]">
          {t("agentChatReasoning")}
        </div>
        <div className="truncate text-xs text-[var(--app-text-secondary)]" title={modelLabel}>{modelLabel}</div>
      </div>
      {effort ? (
        <div role="radiogroup" aria-label={t("agentChatReasoning")} className="flex flex-col gap-0.5 overflow-y-auto p-1.5">
          {effort.choices.map((choice) => {
            const selected = choice.value === effort.current;
            return (
              <button
                key={choice.value}
                type="button"
                role="radio"
                aria-checked={selected}
                title={choice.description}
                disabled={!onPick}
                data-current={selected || undefined}
                className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[length:var(--text-row)] text-[var(--app-text-primary)] hover:bg-[var(--app-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)] disabled:opacity-50"
                onClick={() => onPick?.(choice.value)}
              >
                <span className="min-w-0 flex-1 truncate">{choice.label}</span>
                {choice.isDefault ? (
                  <span className="text-[length:var(--text-micro)] text-[var(--app-text-tertiary)]">{t("agentChatReasoningDefault")}</span>
                ) : null}
                {selected ? <Check className="size-3.5 shrink-0" /> : null}
              </button>
            );
          })}
        </div>
      ) : (
        <p className="px-3 py-2 text-xs text-[var(--app-text-tertiary)]">{note ?? t("agentChatReasoningUnsupported")}</p>
      )}
    </div>
  );
}
