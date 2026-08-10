import { useTranslation } from "react-i18next";
import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { EFFORT_LEVELS } from "@/constants/effortMapping";
import type { LaunchProfileDraft, LaunchProfileRuntime, Provider } from "@/types";
import type { KnownCliTool, LaunchEffort } from "@/types/terminal";
import { contextSizeToTokens } from "@/types/provider";
import { Field, Section } from "./launchProfileParts";
import { SELECT_NONE, inputClass, toolLabel } from "./launchProfileHelpers";

type ProviderModel = NonNullable<Provider["models"]>[number];

interface LaunchProfileBasicsCardProps {
  draft: LaunchProfileDraft;
  setDraft: React.Dispatch<React.SetStateAction<LaunchProfileDraft>>;
  activeTool: KnownCliTool;
  providerDisabled: boolean;
  providerOptions: Provider[];
  selectedProviderModels: ProviderModel[];
  selectedProviderDefaultModel: ProviderModel | undefined;
  selectedEffectiveModel: ProviderModel | undefined;
  selectedProfileEffort: LaunchEffort | undefined;
  yoloConfirmOpen: boolean;
  setYoloConfirmOpen: (open: boolean) => void;
}

/** 运行配置页基础卡：名称/Provider/模型/强度/运行位置/描述 + 卡底 YOLO 开关（纯展示，不碰 store） */
export default function LaunchProfileBasicsCard({
  draft,
  setDraft,
  activeTool,
  providerDisabled,
  providerOptions,
  selectedProviderModels,
  selectedProviderDefaultModel,
  selectedEffectiveModel,
  selectedProfileEffort,
  yoloConfirmOpen,
  setYoloConfirmOpen,
}: LaunchProfileBasicsCardProps) {
  const { t } = useTranslation(["providers", "common"]);

  /** 模型下拉文案带上下文窗口标注：未配置窗口时显式标「未配置」而不是留白。
   * 优先用 `contextSize` 字符串（`"1m"` / `"500k"` 等，会拼到 ANTHROPIC_MODEL 后缀），
   * 兼容 `contextWindowTokens` 数字形式。 */
  const providerModelOptionLabel = (model: ProviderModel) => {
    const base = model.label ? `${model.label} (${model.id})` : model.id;
    const sizeTokens = model.contextSize ? contextSizeToTokens(model.contextSize) : 0;
    const window = sizeTokens > 0
      ? t("modelContextWindowTokens", { window: sizeTokens.toLocaleString("en-US") })
      : model.contextWindowTokens == null
        ? t("modelContextWindowUnknown")
        : t("modelContextWindowTokens", { window: model.contextWindowTokens.toLocaleString("en-US") });
    return `${base} - ${window}`;
  };

  return (
    <Section
      title={t("sectionBasicTitle")}
      description=""
      icon={<KeyRound size={16} />}
    >
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field label={t("fieldAlias")}>
          <input
            className={inputClass}
            value={draft.alias ?? draft.name ?? ""}
            onChange={(event) => setDraft((current) => ({ ...current, alias: event.target.value, name: event.target.value }))}
          />
        </Field>
        {providerDisabled ? (
          <Field label={t("fieldRuntime")}>
            <Select
              value={draft.targetRuntime ?? SELECT_NONE}
              onValueChange={(value) => setDraft((current) => ({
                ...current,
                targetRuntime: value === SELECT_NONE ? null : value as Exclude<LaunchProfileRuntime, null>,
              }))}
            >
              <SelectTrigger aria-label={t("fieldRuntime")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={SELECT_NONE}>{t("runtimeAll")}</SelectItem>
                <SelectItem value="local">{t("runtime.local")}</SelectItem>
                <SelectItem value="wsl">{t("runtime.wsl")}</SelectItem>
                <SelectItem value="ssh">{t("runtime.ssh")}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        ) : (
          <Field label={t("fieldProvider")}>
            <Select
              value={draft.providerId ?? SELECT_NONE}
              onValueChange={(value) => setDraft((current) => {
                const adapterOptions = { ...(current.adapterOptions ?? {}) };
                if (activeTool === "kimi") delete adapterOptions.kimiConfigMode;
                return {
                  ...current,
                  providerId: value === SELECT_NONE ? null : value,
                  modelId: null,
                  adapterOptions,
                };
              })}
            >
              <SelectTrigger aria-label={t("fieldProvider")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={SELECT_NONE}>{t("noProviderSpecified")}</SelectItem>
                {providerOptions.map((provider) => <SelectItem key={provider.id} value={provider.id}>{provider.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
        )}
      </div>
      {!providerDisabled && (
        <>
      <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field label={t("fieldModel")}>
          <Select
            disabled={providerDisabled || !draft.providerId || selectedProviderModels.length === 0}
            value={draft.modelId ?? SELECT_NONE}
            onValueChange={(value) => setDraft((current) => ({ ...current, modelId: value === SELECT_NONE ? null : value }))}
          >
            <SelectTrigger aria-label={t("fieldModel")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={SELECT_NONE}>
                {selectedProviderDefaultModel
                  ? t("useProviderDefaultModel", {
                      model: providerModelOptionLabel(selectedProviderDefaultModel),
                    })
                  : t("nativeCliDefaultModel")}
              </SelectItem>
              {draft.modelId && !selectedProviderModels.some((model) => model.id === draft.modelId) && (
                <SelectItem value={draft.modelId}>{t("missingProviderModel", { model: draft.modelId })}</SelectItem>
              )}
              {selectedProviderModels.map((model) => (
                <SelectItem key={model.id} value={model.id}>
                  {providerModelOptionLabel(model)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {(activeTool === "claude" || activeTool === "codex") && (
          <Field label={t("fieldReasoningEffort")}>
            <Select
              disabled={providerDisabled}
              value={selectedProfileEffort ?? SELECT_NONE}
              onValueChange={(value) => setDraft((current) => {
                const adapterOptions = { ...(current.adapterOptions ?? {}) };
                if (value !== SELECT_NONE) {
                  adapterOptions.effort = value as LaunchEffort;
                } else {
                  delete adapterOptions.effort;
                }
                return { ...current, adapterOptions };
              })}
            >
              <SelectTrigger aria-label={t("fieldReasoningEffort")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={SELECT_NONE}>
                  {selectedEffectiveModel?.defaultEffort
                    ? t("useModelDefaultEffort", {
                        effort: t(`reasoningEffortLevel.${selectedEffectiveModel.defaultEffort}`),
                      })
                    : t("useCliDefaultEffort")}
                </SelectItem>
                {EFFORT_LEVELS.map((level) => (
                  <SelectItem key={level} value={level}>{t(`reasoningEffortLevel.${level}`)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )}
      </div>
      <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field label={t("fieldApplicableCli")}>
          <div className={cn(inputClass, "flex items-center")}>
            {toolLabel(activeTool, t)}
          </div>
        </Field>
        <Field label={t("fieldRuntime")}>
          <Select
            value={draft.targetRuntime ?? SELECT_NONE}
            onValueChange={(value) => setDraft((current) => ({
              ...current,
              targetRuntime: value === SELECT_NONE ? null : value as Exclude<LaunchProfileRuntime, null>,
            }))}
          >
            <SelectTrigger aria-label={t("fieldRuntime")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={SELECT_NONE}>{t("runtimeAll")}</SelectItem>
              <SelectItem value="local">{t("runtime.local")}</SelectItem>
              <SelectItem value="wsl">{t("runtime.wsl")}</SelectItem>
              <SelectItem value="ssh">{t("runtime.ssh")}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>
        </>
      )}
      <div className="mt-1 text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
        {t("runtimeHint")}
      </div>
      <div className="mt-3">
        <Field label={t("fieldDescription")}>
          <input
            className={inputClass}
            value={draft.description ?? ""}
            onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
          />
        </Field>
      </div>

      {/* 权限：原独立半空卡压缩为基础卡底部一条 Switch 行（危险态保留二次确认） */}
      <div className="mt-4 flex items-start gap-3 border-t border-[var(--app-border)]/60 pt-3.5">
        <Switch
          className="mt-0.5"
          aria-label="YOLO mode"
          checked={draft.yoloMode ?? false}
          onCheckedChange={(next) => {
            if (next) {
              // 开启 = 危险操作：先弹二次确认，确认前不写入 draft
              setYoloConfirmOpen(true);
            } else {
              setYoloConfirmOpen(false);
              setDraft((current) => ({ ...current, yoloMode: false }));
            }
          }}
        />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium" style={{ color: "var(--app-text-primary)" }}>
            YOLO mode
            {draft.yoloMode ? (
              <span className="ml-2 align-middle text-[11px] font-semibold text-destructive">
                {t("yoloBypassed")}
              </span>
            ) : null}
          </div>
          <div className="mt-0.5 text-xs" style={{ color: "var(--app-text-tertiary)" }}>{t("yoloDesc")}</div>
          <div className="mt-1 text-[11px] leading-5" style={{ color: "var(--app-text-tertiary)" }}>
            {t("yoloFootnote")}
          </div>

          {yoloConfirmOpen && !draft.yoloMode ? (
            <div className="mt-2 rounded-md border border-destructive/60 bg-destructive/10 px-3 py-2 text-xs leading-5">
              <p className="font-medium text-destructive">{t("yoloConfirmTitle")}</p>
              <p className="mt-1" style={{ color: "var(--app-text-tertiary)" }}>
                {t("yoloConfirmBody")}
              </p>
              <div className="mt-2 flex gap-2">
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  onClick={() => {
                    setDraft((current) => ({ ...current, yoloMode: true }));
                    setYoloConfirmOpen(false);
                  }}
                >
                  {t("yoloConfirmBtn")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setYoloConfirmOpen(false)}
                >
                  {t("common:cancel")}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </Section>
  );
}
