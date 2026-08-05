import { Plus, Star, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EFFORT_LEVELS } from "@/constants/effortMapping";
import type { ProviderModel } from "@/types/provider";
import type { LaunchEffort } from "@/types/terminal";
import { SELECT_NONE } from "./launchProfileHelpers";

interface ProviderModelsEditorProps {
  models: ProviderModel[];
  defaultIndex: number | null;
  onChange: (models: ProviderModel[], defaultIndex: number | null) => void;
}

export default function ProviderModelsEditor({
  models,
  defaultIndex,
  onChange,
}: ProviderModelsEditorProps) {
  const { t } = useTranslation("settings");

  const addModel = () => {
    if (models.length >= 100) return;
    onChange([...models, { id: "", label: null, defaultEffort: null }], defaultIndex ?? 0);
  };

  const updateModel = (index: number, update: Partial<ProviderModel>) => {
    onChange(
      models.map((model, modelIndex) => modelIndex === index ? { ...model, ...update } : model),
      defaultIndex,
    );
  };

  const removeModel = (index: number) => {
    const nextModels = models.filter((_, modelIndex) => modelIndex !== index);
    let nextDefault = defaultIndex;
    if (nextModels.length === 0) nextDefault = null;
    else if (defaultIndex === index) nextDefault = 0;
    else if (defaultIndex !== null && defaultIndex > index) nextDefault = defaultIndex - 1;
    onChange(nextModels, nextDefault);
  };

  return (
    <section className="border-t pt-5" style={{ borderColor: "var(--app-border)" }}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold" style={{ color: "var(--app-text-primary)" }}>
            {t("providerModels")}
          </h3>
          <p className="mt-1 text-xs leading-5" style={{ color: "var(--app-text-secondary)" }}>
            {t("providerModelsHint")}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 shrink-0 text-xs"
          disabled={models.length >= 100}
          onClick={addModel}
        >
          <Plus size={14} /> {t("addProviderModel")}
        </Button>
      </div>

      {models.length === 0 ? (
        <div
          className="rounded-md border border-dashed px-3 py-4 text-center text-xs"
          style={{ borderColor: "var(--app-border)", color: "var(--app-text-tertiary)" }}
        >
          {t("noProviderModels")}
        </div>
      ) : (
        <div className="space-y-2">
          {models.map((model, index) => {
            const isDefault = index === defaultIndex;
            const idInputId = `provider-model-id-${index}`;
            const labelInputId = `provider-model-label-${index}`;
            const effortInputId = `provider-model-effort-${index}`;
            return (
              <div
                key={index}
                data-testid={`provider-model-row-${index}`}
                className="grid grid-cols-1 items-end gap-2 rounded-md border p-2.5 sm:grid-cols-2 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(8rem,0.75fr)_auto]"
                style={{ borderColor: "var(--app-border)", background: "var(--app-panel-bg)" }}
              >
                <div className="min-w-0 space-y-1.5">
                  <Label htmlFor={idInputId} className="text-[11px]">{t("providerModelId")}</Label>
                  <Input
                    id={idInputId}
                    className="h-9 text-sm"
                    maxLength={256}
                    value={model.id}
                    onChange={(event) => updateModel(index, { id: event.target.value })}
                    placeholder={t("providerModelIdPlaceholder")}
                  />
                </div>
                <div className="min-w-0 space-y-1.5">
                  <Label htmlFor={labelInputId} className="text-[11px]">{t("providerModelLabel")}</Label>
                  <Input
                    id={labelInputId}
                    className="h-9 text-sm"
                    maxLength={128}
                    value={model.label ?? ""}
                    onChange={(event) => updateModel(index, { label: event.target.value })}
                    placeholder={t("providerModelLabelPlaceholder")}
                  />
                </div>
                <div className="min-w-0 space-y-1.5">
                  <Label htmlFor={effortInputId} className="text-[11px]">
                    {t("providerModelDefaultEffort")}
                  </Label>
                  {/* Radix Select 不接受空串 value，「使用 CLI 默认」走 SELECT_NONE 哨兵再转回 null */}
                  <Select
                    value={model.defaultEffort ?? SELECT_NONE}
                    onValueChange={(value) => updateModel(index, {
                      defaultEffort: value === SELECT_NONE ? null : (value as LaunchEffort),
                    })}
                  >
                    <SelectTrigger
                      id={effortInputId}
                      className="h-9 w-full text-sm"
                      aria-label={t("providerModelDefaultEffort")}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={SELECT_NONE}>{t("providerModelCliDefaultEffort")}</SelectItem>
                      {EFFORT_LEVELS.map((level) => (
                        <SelectItem key={level} value={level}>{t(`providerEffortLevel.${level}`)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex h-9 items-center justify-end gap-1 sm:col-start-2 xl:col-start-auto">
                  <button
                    type="button"
                    className="flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-[var(--app-hover)]"
                    style={{ color: isDefault ? "var(--app-accent)" : "var(--app-text-tertiary)" }}
                    aria-label={t(isDefault ? "defaultProviderModel" : "setDefaultProviderModel")}
                    aria-pressed={isDefault}
                    title={t(isDefault ? "defaultProviderModel" : "setDefaultProviderModel")}
                    onClick={() => onChange(models, index)}
                  >
                    <Star size={16} fill={isDefault ? "currentColor" : "none"} />
                  </button>
                  <button
                    type="button"
                    className="flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-[var(--app-hover)]"
                    style={{ color: "var(--app-text-tertiary)" }}
                    aria-label={t("removeProviderModel")}
                    title={t("removeProviderModel")}
                    onClick={() => removeModel(index)}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
                {isDefault && (
                  <span className="text-[10px] font-medium sm:col-span-2 xl:col-span-4" style={{ color: "var(--app-accent)" }}>
                    {t("defaultProviderModel")}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
