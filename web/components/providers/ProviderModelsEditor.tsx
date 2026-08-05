import { Plus, Star, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EFFORT_LEVELS } from "@/constants/effortMapping";
import {
  CONTEXT_WINDOW_PRESETS,
  findContextWindowPreset,
} from "@/constants/contextWindowPresets";
import {
  MAX_PROVIDER_CONTEXT_WINDOW_TOKENS,
  MIN_PROVIDER_CONTEXT_WINDOW_TOKENS,
  type ProviderModel,
} from "@/types/provider";
import type { LaunchEffort } from "@/types/terminal";

interface ProviderModelsEditorProps {
  models: ProviderModel[];
  defaultIndex: number | null;
  onChange: (models: ProviderModel[], defaultIndex: number | null) => void;
}

/** 当 contextWindowTokens 不在预设表内时，下拉用此虚拟选项识别「自定义」分支 */
const CUSTOM_PRESET_TOKENS = "__custom__";

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
        <div className="space-y-3">
          {models.map((model, index) => {
            const isDefault = index === defaultIndex;
            const idInputId = `provider-model-id-${index}`;
            const labelInputId = `provider-model-label-${index}`;
            const contextWindowInputId = `provider-model-context-window-${index}`;
            const contextWindowHintId = `provider-model-context-window-${index}-hint`;
            const contextWindowPresetId = `provider-model-context-window-preset-${index}`;
            const effortInputId = `provider-model-effort-${index}`;
            const matchedPreset = findContextWindowPreset(model.contextWindowTokens);
            const isCustomValue =
              model.contextWindowTokens != null && !matchedPreset;
            // 下拉选中值：null → ''（未知），匹配预设 → 'preset:<tokens>'，自定义 → CUSTOM_PRESET_TOKENS
            const presetSelectValue =
              model.contextWindowTokens == null
                ? ""
                : matchedPreset
                  ? `preset:${matchedPreset.tokens}`
                  : CUSTOM_PRESET_TOKENS;
            // 当前数字值（用于 input value）：null 显示空，否则原值
            const contextWindowDisplayValue =
              model.contextWindowTokens == null ? "" : String(model.contextWindowTokens);
            return (
              <div
                key={index}
                data-testid={`provider-model-row-${index}`}
                className="rounded-md border p-4"
                style={{ borderColor: "var(--app-border)", background: "var(--app-content)" }}
              >
                {/* 卡片顶部行：标题 + 默认标记 + 操作按钮。同一行内布局清晰。 */}
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      className="truncate text-sm font-medium"
                      style={{ color: "var(--app-text-primary)" }}
                    >
                      {model.id || `Model ${index + 1}`}
                    </span>
                    {isDefault && (
                      <span
                        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium"
                        style={{
                          color: "var(--app-accent)",
                          background: "var(--app-hover)",
                        }}
                      >
                        <Star size={10} fill="currentColor" />
                        {t("defaultProviderModel")}
                      </span>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
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
                </div>

                {/* 字段区：每行 Label 在左 30%，控件在右 70%。所有 Label 上下对齐成一条线。 */}
                <div className="space-y-3">
                  <FieldRow htmlFor={idInputId} label={t("providerModelId")}>
                    <Input
                      id={idInputId}
                      className="h-9 text-sm"
                      maxLength={256}
                      value={model.id}
                      onChange={(event) => updateModel(index, { id: event.target.value })}
                      placeholder={t("providerModelIdPlaceholder")}
                    />
                  </FieldRow>

                  <FieldRow htmlFor={labelInputId} label={t("providerModelLabel")}>
                    <Input
                      id={labelInputId}
                      className="h-9 text-sm"
                      maxLength={128}
                      value={model.label ?? ""}
                      onChange={(event) => updateModel(index, { label: event.target.value })}
                      placeholder={t("providerModelLabelPlaceholder")}
                    />
                  </FieldRow>

                  <FieldRow
                    htmlFor={contextWindowInputId}
                    label={t("providerModelContextWindow")}
                    hint={
                      isCustomValue
                        ? t("providerModelContextWindowCustomHint")
                        : t("providerModelContextWindowHint")
                    }
                  >
                    {/* 容器内是「常用容量」下拉 + 数字 input 并列。value 一致，下拉选预设即同步填数字。 */}
                    <div className="grid grid-cols-[minmax(10rem,1fr)_minmax(8rem,0.5fr)] gap-2">
                      <select
                        id={contextWindowPresetId}
                        data-testid={`provider-model-context-window-preset-${index}`}
                        className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                        value={presetSelectValue}
                        onChange={(event) => {
                          const raw = event.target.value;
                          if (raw === "") {
                            updateModel(index, { contextWindowTokens: null });
                            return;
                          }
                          if (raw === CUSTOM_PRESET_TOKENS) {
                            // 切到「自定义」分支：保留原数值
                            return;
                          }
                          if (raw.startsWith("preset:")) {
                            const next = Number(raw.slice("preset:".length));
                            if (Number.isFinite(next)) {
                              updateModel(index, { contextWindowTokens: next });
                            }
                          }
                        }}
                      >
                        <option value="">{t("providerModelContextWindowUnknown")}</option>
                        {CONTEXT_WINDOW_PRESETS.map((preset) => {
                          const optionValue = `preset:${preset.tokens}`;
                          const formatted = preset.tokens.toLocaleString("en-US");
                          return (
                            <option
                              key={optionValue}
                              value={optionValue}
                              title={preset.familyHint}
                            >
                              {t(`providerContextWindow.${preset.size}`, {
                                tokens: formatted,
                                defaultValue: preset.labelKey,
                              })}
                            </option>
                          );
                        })}
                        {isCustomValue && (
                          <option value={CUSTOM_PRESET_TOKENS}>
                            {t("providerModelContextWindowCustom", {
                              tokens: contextWindowDisplayValue,
                            })}
                          </option>
                        )}
                      </select>
                      <Input
                        id={contextWindowInputId}
                        type="number"
                        inputMode="numeric"
                        min={MIN_PROVIDER_CONTEXT_WINDOW_TOKENS}
                        max={MAX_PROVIDER_CONTEXT_WINDOW_TOKENS}
                        step={1}
                        className="h-9 text-sm"
                        value={contextWindowDisplayValue}
                        aria-describedby={contextWindowHintId}
                        onChange={(event) => {
                          const value = event.target.value.trim();
                          if (value === "") {
                            updateModel(index, { contextWindowTokens: null });
                            return;
                          }
                          // 不在 input 层截断：让用户输入 10000000.5 / 超出范围之类的值，
                          // 由 ProviderFormPanel 的 isValidProviderContextWindowTokens 在保存时统一报错。
                          const next = Number(value);
                          if (!Number.isFinite(next)) return;
                          updateModel(index, { contextWindowTokens: next });
                        }}
                        placeholder={t("providerModelContextWindowPlaceholder")}
                      />
                    </div>
                  </FieldRow>

                  <FieldRow htmlFor={effortInputId} label={t("providerModelDefaultEffort")}>
                    <select
                      id={effortInputId}
                      className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                      value={model.defaultEffort ?? ""}
                      onChange={(event) => updateModel(index, {
                        defaultEffort: (event.target.value || null) as LaunchEffort | null,
                      })}
                    >
                      <option value="">{t("providerModelCliDefaultEffort")}</option>
                      {EFFORT_LEVELS.map((level) => (
                        <option key={level} value={level}>{t(`providerEffortLevel.${level}`)}</option>
                      ))}
                    </select>
                  </FieldRow>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/**
 * 一个 Label 在左、控件在右的横排字段。所有字段 Label 列宽相同 → 整齐。
 * hint 可选：放在 Label 同一栏，溢出时换行避开控件。
 */
function FieldRow({
  htmlFor,
  label,
  hint,
  children,
}: {
  htmlFor: string;
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-1 items-start gap-x-3 gap-y-1.5 sm:grid-cols-[minmax(7rem,30%)_minmax(0,1fr)]">
      <div className="space-y-1">
        <Label htmlFor={htmlFor} className="text-[11px]">{label}</Label>
        {hint && (
          <p className="text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
            {hint}
          </p>
        )}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
