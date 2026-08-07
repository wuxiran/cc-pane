import { Plus, Star, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EFFORT_LEVELS } from "@/constants/effortMapping";
import {
  CONTEXT_WINDOW_PRESETS,
  findContextWindowPreset,
} from "@/constants/contextWindowPresets";
import type { ProviderModel } from "@/types/provider";
import type { LaunchEffort } from "@/types/terminal";
import { SELECT_NONE } from "./launchProfileHelpers";

/** 当 contextWindowTokens 不在预设表内时，下拉用此虚拟选项识别「自定义」分支 */
const CUSTOM_PRESET_VALUE = "__custom__";

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
    <section className="pt-1">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-[13px] font-semibold" style={{ color: "var(--app-text-primary)" }}>
            {t("providerModels")}
          </h3>
          <p className="mt-0.5 text-[11px] leading-4" style={{ color: "var(--app-text-secondary)" }}>
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
            const contextWindowInputId = `provider-model-context-window-${index}`;
            const contextWindowPresetId = `provider-model-context-window-preset-${index}`;
            const matchedPreset = findContextWindowPreset(model.contextWindowTokens);
            const isCustomContextWindow = model.contextWindowTokens != null && !matchedPreset;
            // 下拉选中值：null → SELECT_NONE（未知/不配置），命中预设 → tokens 字符串，其余 → 自定义哨兵
            const contextWindowPresetValue = model.contextWindowTokens == null
              ? SELECT_NONE
              : matchedPreset
                ? String(matchedPreset.tokens)
                : CUSTOM_PRESET_VALUE;
            const contextWindowDisplayValue = model.contextWindowTokens == null
              ? ""
              : String(model.contextWindowTokens);
            return (
              <div
                key={index}
                data-testid={`provider-model-row-${index}`}
                className="grid grid-cols-1 gap-3 rounded-lg border p-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(10rem,0.8fr)_auto]"
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
                <div className="min-w-0 space-y-1.5 sm:col-span-2 lg:col-span-3">
                  <Label htmlFor={contextWindowInputId} className="text-[11px]">
                    {t("providerModelContextWindow")}
                  </Label>
                  <div className="flex items-center gap-1.5">
                    {/* 常用容量预设：选中即写数值；「未知」写 null 走 WINDOW_UNKNOWN 降级 */}
                    <Select
                      value={contextWindowPresetValue}
                      onValueChange={(value) => {
                        if (value === SELECT_NONE) {
                          updateModel(index, { contextWindowTokens: null });
                          return;
                        }
                        if (value === CUSTOM_PRESET_VALUE) return;
                        const next = Number(value);
                        if (Number.isFinite(next)) updateModel(index, { contextWindowTokens: next });
                      }}
                    >
                    <SelectTrigger
                      id={contextWindowPresetId}
                      className="h-9 w-32 shrink-0 text-sm"
                        aria-label={t("providerModelContextWindowPreset")}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={SELECT_NONE}>
                          {t("providerModelContextWindowUnknown")}
                        </SelectItem>
                        {CONTEXT_WINDOW_PRESETS.map((preset) => (
                          <SelectItem
                            key={preset.size}
                            value={String(preset.tokens)}
                            title={preset.familyHint}
                          >
                            {t(`providerContextWindow.${preset.size}` as never)}
                          </SelectItem>
                        ))}
                        {isCustomContextWindow && (
                          <SelectItem value={CUSTOM_PRESET_VALUE}>
                            {t("providerModelContextWindowCustom", { tokens: contextWindowDisplayValue })}
                          </SelectItem>
                        )}
                      </SelectContent>
                    </Select>
                    <Input
                      id={contextWindowInputId}
                      className="h-9 min-w-0 text-sm"
                      inputMode="numeric"
                      value={contextWindowDisplayValue}
                      placeholder={t("providerModelContextWindowPlaceholder")}
                      onChange={(event) => {
                        const raw = event.target.value.trim();
                        if (raw === "") {
                          updateModel(index, { contextWindowTokens: null });
                          return;
                        }
                        const next = Number(raw);
                        if (!Number.isFinite(next)) return;
                        updateModel(index, { contextWindowTokens: next });
                      }}
                    />
                  </div>
                  <p className="text-[10px] leading-4" style={{ color: "var(--app-text-tertiary)" }}>
                    {isCustomContextWindow
                      ? t("providerModelContextWindowCustomHint")
                      : t("providerModelContextWindowHint")}
                  </p>
                </div>
                <div className="flex h-9 items-center justify-end gap-1 sm:col-start-2 lg:col-start-auto">
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
                  <span className="text-[10px] font-medium sm:col-span-2 lg:col-span-4" style={{ color: "var(--app-accent)" }}>
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
