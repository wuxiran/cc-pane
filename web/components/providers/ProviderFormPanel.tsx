import { useState, useMemo, useCallback, useEffect, useRef, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ArrowLeft, Eye, EyeOff, ExternalLink, FolderOpen, FileText, Settings } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useProvidersStore } from "@/stores";
import { providerService } from "@/services/providerService";
import { filesystemService } from "@/services/filesystemService";
import { isTauriRuntime } from "@/services/runtime";
import { isJsonFile } from "@/utils/json";
import { lazyWithRetry } from "@/lib/lazyRetry";
import ProviderAvatar from "./ProviderAvatar";
import UnsavedChangesDialog from "./UnsavedChangesDialog";
import { useProviderFormUnsavedChanges } from "./useProviderFormUnsavedChanges";
import {
  PROVIDER_TYPE_META, isValidProviderContextWindowTokens,
  type Provider,
  type ProviderType,
  type ProviderPreset,
  type ConfigDirInfo,
} from "@/types/provider";
import type { KnownCliTool } from "@/types/terminal";
import ProviderTypeSelect from "./ProviderTypeSelect";
import {
  buildConfigJson,
  createInitialForm,
  parseConfigJson,
  type FormState,
} from "./providerFormState";
import ProviderModelsEditor from "./ProviderModelsEditor";

const JsonEditor = lazyWithRetry(() => import("@/components/editor/JsonEditor"), "JsonEditor");
/** 根据当前 Tab 推导手动创建时的默认 ProviderType */
function defaultProviderTypeForTab(tab?: KnownCliTool): ProviderType {
  switch (tab) {
    case "codex":
    case "pi": return tab === "pi" ? "anthropic" : "open_ai";
    case "gemini": return "gemini";
    case "kimi": return "kimi";
    case "glm": return "glm";
    case "opencode": return "opencode";
    case "cursor": return "cursor";
    case "grok": return "grok";
    default: return "anthropic";
  }
}
interface ProviderFormPanelProps {
  editProvider?: Provider | null;
  /**
   * 复制目标复制走「新建保存」路径：保留被复制 provider 的字段作为初始 form 值，
   * 但 `id` 重新生成、保存走 addProvider 分支。
   * 与 editProvider 互斥：传入 duplicateSeed 时忽略 editProvider。
   */
  duplicateSeed?: Provider | null;
  preset?: ProviderPreset | null;
  activeTab?: KnownCliTool;
  compact?: boolean;
  onBack: () => void;
  onSaved?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}
export default function ProviderFormPanel({ editProvider, duplicateSeed, preset, activeTab, compact, onBack, onSaved, onDirtyChange }: ProviderFormPanelProps) {
  const { t } = useTranslation(["settings", "common"]);
  const providers = useProvidersStore((s) => s.providers);
  const addProvider = useProvidersStore((s) => s.addProvider);
  const updateProvider = useProvidersStore((s) => s.updateProvider);

  const isEditMode = !!editProvider;
  const isPresetMode = !!preset && !editProvider;
  const initialFormRef = useRef<FormState>(createInitialForm(
    editProvider ?? duplicateSeed,
    preset,
    defaultProviderTypeForTab(activeTab),
    preset ? t(preset.nameKey as any) : "",
  ));
  const [form, setForm] = useState<FormState>(() => initialFormRef.current!);
  const [configDirInfo, setConfigDirInfo] = useState<ConfigDirInfo | null>(null);
  const currentMeta = useMemo(() => PROVIDER_TYPE_META[form.providerType], [form.providerType]);
  // config_profile JSON 编辑器状态
  const [configFileContent, setConfigFileContent] = useState("");
  const [configFileOriginal, setConfigFileOriginal] = useState("");
  const isConfigJsonFile = form.providerType === "config_profile" && isJsonFile(form.configDir);
  // 非 config_profile 的配置 JSON 编辑器状态
  const [configJson, setConfigJson] = useState(() =>
    form.providerType !== "config_profile" ? buildConfigJson(form) : "",
  );
  const [showSensitiveJson, setShowSensitiveJson] = useState(false);
  const isUpdatingRef = useRef(false);
  const { configFileIsDirty, discardGuard, requestBack } = useProviderFormUnsavedChanges({
    form,
    initialForm: initialFormRef.current!,
    providerType: form.providerType,
    configJson,
    configFileContent,
    configFileOriginal,
    onBack,
    onDirtyChange,
  });

  // 表单字段 → JSON 同步
  useEffect(() => {
    if (form.providerType === "config_profile") return;
    if (isUpdatingRef.current) return;
    setConfigJson(buildConfigJson(form));
  }, [form.apiKey, form.baseUrl, form.region, form.projectId, form.awsProfile, form.providerType]);

  // JSON → 表单字段 同步
  const handleConfigJsonChange = useCallback((newJson: string) => {
    setConfigJson(newJson);
    isUpdatingRef.current = true;
    const parsed = parseConfigJson(newJson, form.providerType);
    if (parsed) {
      setForm((prev) => ({ ...prev, ...parsed }));
    }
    // 用 setTimeout 确保同步完成后再解除锁定
    setTimeout(() => { isUpdatingRef.current = false; }, 0);
  }, [form.providerType]);

  const loadConfigDirInfo = useCallback(async (dir: string) => {
    if (!dir) { setConfigDirInfo(null); return; }
    try {
      const info = await providerService.readConfigDirInfo(dir);
      setConfigDirInfo(info);
    } catch { setConfigDirInfo(null); }
  }, []);

  // 当选择了 JSON 文件时，加载文件内容
  useEffect(() => {
    if (!isConfigJsonFile || !form.configDir) {
      setConfigFileContent("");
      setConfigFileOriginal("");
      return;
    }
    filesystemService.readFile(form.configDir).then((fc) => {
      const content = fc.content ?? "";
      setConfigFileContent(content);
      setConfigFileOriginal(content);
    }).catch(() => {
      setConfigFileContent("");
      setConfigFileOriginal("");
    });
  }, [form.configDir, isConfigJsonFile]);

  function updateForm(partial: Partial<FormState>) {
    setForm((prev) => ({ ...prev, ...partial }));
  }

  function handleTypeChange(newType: ProviderType) {
    const fields = PROVIDER_TYPE_META[newType].fields;
    const updates: Partial<FormState> = { providerType: newType };
    if (!fields.includes("apiKey")) updates.apiKey = "";
    if (!fields.includes("baseUrl")) updates.baseUrl = "";
    if (!fields.includes("region")) updates.region = "";
    if (!fields.includes("projectId")) updates.projectId = "";
    if (!fields.includes("awsProfile")) updates.awsProfile = "";
    if (!fields.includes("configDir")) { updates.configDir = ""; setConfigDirInfo(null); }
    updateForm(updates);
  }

  function shouldShowField(field: string): boolean {
    if (isPresetMode && preset) return preset.userFields.includes(field);
    return currentMeta.fields.includes(field);
  }

  function isPresetDefault(field: string): boolean {
    if (!isPresetMode || !preset) return false;
    return field in preset.defaults && !preset.userFields.includes(field);
  }

  async function handleSave() {
    if (!form.name.trim()) { toast.error(t("nameRequired")); return; }
    const models = form.models.map((model) => ({
      id: model.id.trim(),
      label: model.label?.trim() || null,
      defaultEffort: model.defaultEffort ?? null,
      ...(model.contextWindowTokens === undefined ? {} : { contextWindowTokens: model.contextWindowTokens ?? null }),
    }));
    if (models.some((model) => !model.id)) { toast.error(t("providerModelIdRequired")); return; }
    if (models.some((model) => !isValidProviderContextWindowTokens(model.contextWindowTokens))) { toast.error(t("providerModelContextWindowInvalid")); return; }
    if (new Set(models.map((model) => model.id)).size !== models.length) {
      toast.error(t("providerModelIdsUnique"));
      return;
    }
    try {
      // 如果 config_profile 且 JSON 文件有修改，先写回文件
      if (isConfigJsonFile && configFileIsDirty) {
        await filesystemService.writeFile(form.configDir, configFileContent);
        setConfigFileOriginal(configFileContent);
        toast.success(t("jsonFileSaved"));
      }

      // 复制种子路径永远走 add：editProvider 为空或 duplicateSeed 非空 → 一律 add。
      const saveAsUpdate = !!editProvider && !duplicateSeed;
      const provider: Provider = {
        // 只有 update 路径复用既有 id；add 路径（含复制种子）一律重新生成，
        // 防御调用方忘记换 id 时把复制写成覆盖原 Provider。
        id: saveAsUpdate ? editProvider.id : crypto.randomUUID(),
        name: form.name.trim(),
        providerType: form.providerType,
        apiKey: form.apiKey || null,
        baseUrl: form.baseUrl || null,
        region: form.region || null,
        projectId: form.projectId || null,
        awsProfile: form.awsProfile || null,
        configDir: form.configDir || null,
        models,
        defaultModelId: form.defaultModelIndex === null ? null : models[form.defaultModelIndex]?.id ?? models[0]?.id ?? null,
        isDefault: false,
      };
      if (saveAsUpdate) {
        const existing = providers.find((p) => p.id === editProvider.id);
        if (existing) provider.isDefault = existing.isDefault;
        await updateProvider(provider);
        toast.success(t("providerUpdated"));
      } else {
        await addProvider(provider);
        toast.success(t("providerAdded"));
      }
      (onSaved ?? onBack)();
    } catch (e) {
      toast.error(t("operationFailed", { error: String(e) }));
    }
  }

  async function handleBrowseConfigDir() {
    if (!isTauriRuntime()) {
      const selected = window.prompt(t("selectConfigDir"), form.configDir);
      if (selected) {
        updateForm({ configDir: selected });
        loadConfigDirInfo(selected);
      }
      return;
    }
    const selected = await open({ directory: true, multiple: false, title: t("selectConfigDir") });
    if (selected) {
      updateForm({ configDir: selected as string });
      loadConfigDirInfo(selected as string);
    }
  }

  async function handleBrowseConfigFile() {
    if (!isTauriRuntime()) {
      const selected = window.prompt(t("selectCcswitchFile"), form.configDir);
      if (selected) {
        updateForm({ configDir: selected });
        loadConfigDirInfo(selected);
      }
      return;
    }
    const selected = await open({
      directory: false, multiple: false,
      title: t("selectCcswitchFile"),
      filters: [{ name: t("jsonFiles"), extensions: ["json"] }],
    });
    if (selected) {
      updateForm({ configDir: selected as string });
      loadConfigDirInfo(selected as string);
    }
  }

  async function handleOpenInExplorer(path: string) {
    try { await providerService.openPathInExplorer(path); }
    catch (e) { toast.error(t("openFailed", { error: String(e) })); }
  }

  const accentColor = preset?.accentColor || undefined;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className={`flex shrink-0 items-center gap-2 ${compact ? "py-2.5" : "px-6 py-2.5"}`}>
        <button
          type="button"
          aria-label={t("back", { ns: "common" })}
          className="flex size-8 items-center justify-center rounded-md text-[var(--app-text-secondary)] transition-colors hover:bg-[var(--app-hover)] hover:text-[var(--app-text-primary)]"
          onClick={requestBack}
        >
          <ArrowLeft size={18} />
        </button>
        <h2 className="text-[14px] font-semibold" style={{ color: "var(--app-text-primary)" }}>
          {isEditMode ? t("editProvider") : t("addProvider")}
        </h2>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className={`mx-auto w-full ${compact ? "py-3" : "max-w-2xl px-6 py-5"}`}>
          {isPresetMode && (
            <div className="mb-5 flex items-center gap-3">
            <ProviderAvatar
              name={form.name || "?"}
              providerType={form.providerType}
              accentColor={accentColor}
              size={40}
            />
            <div>
              <div className="text-[14px] font-semibold" style={{ color: "var(--app-text-primary)" }}>
                {form.name || t("providerNamePlaceholder")}
              </div>
              {preset?.website && (
                <a
                  href={preset.website}
                  target="_blank" rel="noopener noreferrer"
                  className="flex items-center gap-1 text-xs mt-1 hover:underline"
                  style={{ color: "var(--app-text-link, var(--app-accent))" }}
                >
                  {t("getApiKey")} <ExternalLink size={12} />
                </a>
              )}
            </div>
            </div>
          )}

          <div className="flex flex-col gap-4">
            {/* Name */}
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs font-medium">{t("providerName")}</Label>
              <Input
                className="h-10 text-sm"
                value={form.name}
                onChange={(e) => updateForm({ name: e.target.value })}
                placeholder={t("providerNamePlaceholder")}
              />
            </div>

            {/* Type */}
            {isPresetMode ? (
              <div className="flex flex-col gap-1.5">
                <Label className="text-xs font-medium">{t("providerType")}</Label>
                <Badge variant="secondary" className="w-fit text-xs px-2.5 py-1">
                  {t(PROVIDER_TYPE_META[form.providerType].labelKey)}
                </Badge>
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                <Label className="text-xs font-medium">{t("providerType")}</Label>
                <ProviderTypeSelect
                  value={form.providerType}
                  onChange={handleTypeChange}
                  activeTab={activeTab}
                />
              </div>
            )}

            {/* Dynamic fields */}
            {shouldShowField("apiKey") && (
              <div className="flex flex-col gap-1.5">
                <Label className="text-xs font-medium">{t("apiKey")}</Label>
                <Input
                  className="h-10 text-sm"
                  type="password"
                  value={form.apiKey}
                  onChange={(e) => updateForm({ apiKey: e.target.value })}
                  placeholder="sk-ant-..."
                />
              </div>
            )}

            {shouldShowField("baseUrl") && (
              <div className="flex flex-col gap-1.5">
                <Label className="text-xs font-medium">{t("baseUrl")}</Label>
                <Input
                  className="h-10 text-sm"
                  value={form.baseUrl}
                  onChange={(e) => updateForm({ baseUrl: e.target.value })}
                  placeholder="https://api.anthropic.com"
                  readOnly={isPresetDefault("baseUrl")}
                  style={isPresetDefault("baseUrl") ? { opacity: 0.6 } : undefined}
                />
              </div>
            )}

            {shouldShowField("region") && (
              <div className="flex flex-col gap-1.5">
                <Label className="text-xs font-medium">{t("region")}</Label>
                <Input
                  className="h-10 text-sm"
                  value={form.region}
                  onChange={(e) => updateForm({ region: e.target.value })}
                  placeholder={form.providerType === "bedrock" ? "us-east-1" : "us-central1"}
                />
              </div>
            )}

            {shouldShowField("awsProfile") && (
              <div className="flex flex-col gap-1.5">
                <Label className="text-xs font-medium">{t("awsProfile")}</Label>
                <Input
                  className="h-10 text-sm"
                  value={form.awsProfile}
                  onChange={(e) => updateForm({ awsProfile: e.target.value })}
                  placeholder="default"
                />
              </div>
            )}

            {shouldShowField("projectId") && (
              <div className="flex flex-col gap-1.5">
                <Label className="text-xs font-medium">{t("vertexProjectId")}</Label>
                <Input
                  className="h-10 text-sm"
                  value={form.projectId}
                  onChange={(e) => updateForm({ projectId: e.target.value })}
                  placeholder="my-gcp-project"
                />
              </div>
            )}

            {shouldShowField("configDir") && (
              <div className="flex flex-col gap-2">
                <Label className="text-xs font-medium">{t("configPath")}</Label>
                <Input
                  className="h-10 text-sm"
                  value={form.configDir}
                  onChange={(e) => {
                    updateForm({ configDir: e.target.value });
                    if (e.target.value) loadConfigDirInfo(e.target.value);
                    else setConfigDirInfo(null);
                  }}
                  placeholder={t("configPathPlaceholder")}
                />
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" className="h-8 text-xs" onClick={handleBrowseConfigDir}>
                    <FolderOpen size={13} className="mr-1.5" /> {t("directory")}
                  </Button>
                  <Button variant="outline" size="sm" className="h-8 text-xs" onClick={handleBrowseConfigFile}>
                    <FileText size={13} className="mr-1.5" /> {t("file")}
                  </Button>
                </div>

                {form.configDir && configDirInfo && (
                  <div
                    className="flex flex-col gap-2 p-3 rounded-lg text-xs"
                    style={{ background: "var(--app-panel-bg)", border: "1px solid var(--app-border)" }}
                  >
                    {configDirInfo.files.map((f) => (
                      <div key={f} className="flex items-center gap-2" style={{ color: "var(--app-text-secondary)" }}>
                        <FileText size={12} className="shrink-0" />
                        <span className="truncate">{f}</span>
                        {f === "settings.json" && (
                          <Badge variant={configDirInfo.hasSettings ? "secondary" : "destructive"} className="text-[9px] px-1 py-0 ml-auto">
                            {configDirInfo.hasSettings ? "\u2713" : "\u2717"}
                          </Badge>
                        )}
                        {f === ".credentials.json" && (
                          <Badge variant={configDirInfo.hasCredentials ? "secondary" : "destructive"} className="text-[9px] px-1 py-0 ml-auto">
                            {configDirInfo.hasCredentials ? "\u2713" : "\u2717"}
                          </Badge>
                        )}
                      </div>
                    ))}
                    {configDirInfo.settingsSummary && (
                      <div className="text-[11px] pt-2" style={{ color: "var(--app-text-tertiary)", borderTop: "1px solid var(--app-border)" }}>
                        {configDirInfo.settingsSummary}
                      </div>
                    )}
                    <div className="flex gap-1 pt-2" style={{ borderTop: "1px solid var(--app-border)" }}>
                      <Button variant="ghost" size="sm" className="h-7 text-[11px] px-2" onClick={() => handleOpenInExplorer(form.configDir)}>
                        <ExternalLink size={12} className="mr-1" /> {t("openDir")}
                      </Button>
                    </div>
                  </div>
                )}

                {form.configDir && !configDirInfo && (
                  <div className="text-xs py-1" style={{ color: "var(--app-text-tertiary)" }}>
                    {t("pathNotExist")}
                  </div>
                )}

                {/* config_profile JSON 编辑器 */}
                {isConfigJsonFile && configFileContent !== "" && (
                  <div className="flex flex-col gap-1.5 mt-1">
                    <div className="flex items-center justify-between gap-2">
                      <Label className="text-xs font-medium">{t("jsonConfigFileContent")}</Label>
                      <div className="flex items-center gap-2">
                        {configFileIsDirty && (
                          <Badge variant="outline" className="text-[9px] px-1.5 py-0">
                            {t("unsavedJsonChanges")}
                          </Badge>
                        )}
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 text-[11px] hover:underline"
                          style={{ color: "var(--app-text-link, var(--app-accent))" }}
                          onClick={() => setShowSensitiveJson((current) => !current)}
                        >
                          {showSensitiveJson ? <EyeOff size={11} /> : <Eye size={11} />}
                          {showSensitiveJson ? t("hideSensitiveJson") : t("showSensitiveJson")}
                        </button>
                      </div>
                    </div>
                    {showSensitiveJson && (
                      <Suspense fallback={<div className="h-48 rounded-md border animate-pulse" style={{ background: "var(--app-panel-bg)" }} />}>
                        <JsonEditor
                          value={configFileContent}
                          onChange={setConfigFileContent}
                          rows={16}
                        />
                      </Suspense>
                    )}
                  </div>
                )}
              </div>
            )}

            <ProviderModelsEditor
              models={form.models}
              defaultIndex={form.defaultModelIndex}
              onChange={(models, defaultModelIndex) => updateForm({ models, defaultModelIndex })}
            />

            {/* 非 config_profile 类型的配置 JSON 编辑器 */}
            {form.providerType !== "config_profile" && (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <Label className="text-xs font-medium">{t("jsonConfig")}</Label>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 text-[11px] hover:underline"
                      style={{ color: "var(--app-text-link, var(--app-accent))" }}
                      onClick={() => setShowSensitiveJson((current) => !current)}
                    >
                      {showSensitiveJson ? <EyeOff size={11} /> : <Eye size={11} />}
                      {showSensitiveJson ? t("hideSensitiveJson") : t("showSensitiveJson")}
                    </button>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 text-[11px] hover:underline"
                      style={{ color: "var(--app-text-link, var(--app-accent))" }}
                      onClick={() => {
                        providerService.openPathInExplorer("").catch(() => {});
                      }}
                      title={t("editGlobalConfig")}
                    >
                      <Settings size={11} />
                      {t("editGlobalConfig")}
                    </button>
                  </div>
                </div>
                {showSensitiveJson && (
                  <Suspense fallback={<div className="h-36 rounded-md border animate-pulse" style={{ background: "var(--app-panel-bg)" }} />}>
                    <JsonEditor
                      value={configJson}
                      onChange={handleConfigJsonChange}
                      rows={8}
                    />
                  </Suspense>
                )}
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="mt-6 flex justify-end gap-3 pt-4" style={{ borderTop: "1px solid var(--app-border)" }}>
            <Button variant="secondary" size="default" onClick={requestBack}>
              {t("common:cancel")}
            </Button>
            <Button size="default" onClick={handleSave}>
              {t("common:save")}
            </Button>
          </div>
        </div>
      </div>
      <UnsavedChangesDialog
        open={discardGuard.confirmOpen}
        onCancel={discardGuard.cancel}
        onDiscard={discardGuard.discard}
      />
    </div>
  );
}
