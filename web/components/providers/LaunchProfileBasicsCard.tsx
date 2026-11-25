import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { EFFORT_LEVELS } from "@/constants/effortMapping";
import type { LaunchProfileDraft, Provider } from "@/types";
import type { KnownCliTool, LaunchEffort } from "@/types/terminal";
import { contextSizeToTokens } from "@/types/provider";
import { isLocalWslOnlyCliTool } from "@/utils/cliTool";
import { Field, HintIcon } from "./launchProfileParts";
import { SECTION_IDS, SELECT_NONE, inputClass } from "./launchProfileHelpers";
import PiProfileOptions from "./PiProfileOptions";
import LaunchProfileAccountField from "./LaunchProfileAccountField";
import LaunchProfileCredentialField from "./LaunchProfileCredentialField";
import { providerModelDropdownOptions } from "./providerModelOptions";

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
  onManageCredentials?: () => void;
}

/** 运行配置页基础卡：名称/Provider/模型/强度/描述 + 卡底 YOLO 开关（纯展示，不碰 store） */
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
  onManageCredentials,
}: LaunchProfileBasicsCardProps) {
  const { t } = useTranslation(["providers", "common"]);
  const piFamilyTool = activeTool === "pi" || activeTool === "omp";
  // jcode 与终端 CLI（kiro/fx/muse）同 Pi 家族共享「仅本机/WSL、
  // 无 YOLO」约束，但 Provider 字段不跟 Pi 家族的 managed 特化文案。
  const localWslOnlyTool = isLocalWslOnlyCliTool(activeTool);
  const yoloSupported = !localWslOnlyTool;

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
    <section id={SECTION_IDS.basics} className="scroll-mt-14 px-4 py-3">
      {/* 系统默认：名称固定、不注入供应商，凭证只读一行；其余可编辑字段只在运行配置里出现 */}
      {providerDisabled && (
        <div className="flex items-center gap-1.5 text-[length:var(--text-row)] font-medium" style={{ color: "var(--app-text-primary)" }}>
          {t("fieldCredential")}
          <HintIcon text={t("credentialSystemDefaultHint")} />
          <span className="ml-auto text-[length:var(--text-caption)] font-normal" style={{ color: "var(--app-text-tertiary)" }}>
            {t("credentialKind.cli")}
          </span>
        </div>
      )}
      {!providerDisabled && (
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {/* 别名直接在行头标题上改，这里不再单独占一行 */}
        {/* 非 Pi 家族：凭证拍平为「CLI 自带登录 / OAuth / 中转站」；Pi 家族的 managed provider 语义不同，保留原两级下拉 */}
        {!piFamilyTool && (
          <LaunchProfileCredentialField
            draft={draft}
            setDraft={setDraft}
            providers={providerOptions}
            activeTool={activeTool}
            onManage={onManageCredentials}
          />
        )}
        {piFamilyTool && (
          <>
          <Field label={t("fieldManagedProvider")}>
            <Select
              value={draft.providerId ?? SELECT_NONE}
              onValueChange={(value) => setDraft((current) => {
                const adapterOptions = { ...(current.adapterOptions ?? {}) };
                if (activeTool === "pi") {
                  delete adapterOptions.piNativeProvider;
                  delete adapterOptions.piNativeModel;
                }
                return {
                  ...current,
                  providerId: value === SELECT_NONE ? null : value,
                  // 账号挂在供应商下面：换供应商就回到新供应商的默认账号
                  providerAccountId: null,
                  modelId: null,
                  adapterOptions,
                };
              })}
            >
              <SelectTrigger aria-label={t("fieldManagedProvider")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={SELECT_NONE}>{t("noProviderSpecified")}</SelectItem>
                {providerOptions.map((provider) => <SelectItem key={provider.id} value={provider.id}>{provider.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          {draft.providerId && (
            <LaunchProfileAccountField
              draft={draft}
              setDraft={setDraft}
              provider={providerOptions.find((provider) => provider.id === draft.providerId)}
              cliTool={activeTool}
            />
          )}
          </>
        )}
      </div>
      )}
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
              {providerModelDropdownOptions(selectedProviderModels, draft.modelId).map((model) => (
                <SelectItem key={model.id} value={model.id}>
                  {model.hidden
                    ? t("hiddenProviderModel", { model: providerModelOptionLabel(model) })
                    : providerModelOptionLabel(model)}
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
      {/* 「适用 CLI」已在页头徽章展示，不再占一个只读假输入框；运行配置不区分运行位置（本机/WSL/SSH 通用） */}
        </>
      )}
      {/* 系统默认的说明是固定介绍，已在页头展示，不再伪装成输入框 */}
      {!providerDisabled && (
      <div className="mt-3">
        <Field label={t("fieldDescription")}>
          <input
            className={inputClass}
            value={draft.description ?? ""}
            onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
          />
        </Field>
      </div>
      )}

      {activeTool === "pi" && (
        <PiProfileOptions
          draft={draft}
          setDraft={setDraft}
        />
      )}

      {/* YOLO：一行开关，说明收进 ⓘ；开启是危险操作，保留二次确认 */}
      {yoloSupported && (
      <div className="mt-3 border-t border-[var(--app-border)]/60 pt-3">
        <div className="flex items-center gap-1.5 text-[length:var(--text-row)] font-medium" style={{ color: "var(--app-text-primary)" }}>
          YOLO mode
          <HintIcon text={`${t("yoloDesc")} ${t("yoloFootnote")}`} />
          {draft.yoloMode ? (
            <span className="text-[length:var(--text-caption)] font-semibold text-destructive">
              {t("yoloBypassed")}
            </span>
          ) : null}
          <Switch
            className="ml-auto"
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
      )}
    </section>
  );
}
