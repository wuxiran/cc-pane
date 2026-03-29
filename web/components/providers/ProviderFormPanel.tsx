import { useState, useMemo, useCallback, useEffect, useRef, lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ArrowLeft, ExternalLink, FolderOpen, FileText, Settings } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useProvidersStore } from "@/stores";
import { providerService } from "@/services/providerService";
import { filesystemService } from "@/services/filesystemService";
import { isJsonFile } from "@/utils/json";
import ProviderAvatar from "./ProviderAvatar";
import {
  PROVIDER_TYPE_META,
  getProviderTypesForTab,
  type Provider,
  type ProviderType,
  type ProviderPreset,
  type ConfigDirInfo,
} from "@/types/provider";
import type { KnownCliTool } from "@/types/terminal";

const JsonEditor = lazy(() => import("@/components/editor/JsonEditor"));

interface FormState {
  name: string;
  providerType: ProviderType;
  apiKey: string;
  baseUrl: string;
  region: string;
  projectId: string;
  awsProfile: string;
  configDir: string;
}

const emptyForm: FormState = {
  name: "",
  providerType: "anthropic",
  apiKey: "",
  baseUrl: "",
  region: "",
  projectId: "",
  awsProfile: "",
  configDir: "",
};

/** 根据 Provider 类型，从表单字段构建 {"env": {...}} JSON 字符串 */
function buildConfigJson(form: FormState): string {
  const env: Record<string, string> = {};
  switch (form.providerType) {
    case "anthropic":
      if (form.apiKey) env["ANTHROPIC_API_KEY"] = form.apiKey;
      if (form.baseUrl) env["ANTHROPIC_BASE_URL"] = form.baseUrl;
      break;
    case "bedrock":
      env["CLAUDE_CODE_USE_BEDROCK"] = "1";
      if (form.region) env["AWS_REGION"] = form.region;
      if (form.awsProfile) env["AWS_PROFILE"] = form.awsProfile;
      break;
    case "vertex":
      env["CLAUDE_CODE_USE_VERTEX"] = "1";
      if (form.region) env["CLOUD_ML_REGION"] = form.region;
      if (form.projectId) env["ANTHROPIC_VERTEX_PROJECT_ID"] = form.projectId;
      break;
    case "proxy":
      if (form.apiKey) env["ANTHROPIC_API_KEY"] = form.apiKey;
      if (form.baseUrl) env["ANTHROPIC_BASE_URL"] = form.baseUrl;
      break;
    case "open_ai":
      if (form.apiKey) env["CODEX_API_KEY"] = form.apiKey;
      if (form.baseUrl) env["OPENAI_BASE_URL"] = form.baseUrl;
      break;
    case "gemini":
      if (form.apiKey) env["GEMINI_API_KEY"] = form.apiKey;
      if (form.baseUrl) env["GEMINI_API_BASE"] = form.baseUrl;
      break;
    case "opencode":
      if (form.apiKey) env["OPENAI_API_KEY"] = form.apiKey;
      if (form.baseUrl) env["OPENAI_BASE_URL"] = form.baseUrl;
      break;
    default:
      break;
  }
  return JSON.stringify({ env }, null, 2);
}

/** 从 JSON 字符串解析 env 对象并回填表单字段 */
function parseConfigJson(jsonStr: string, providerType: ProviderType): Partial<FormState> | null {
  try {
    const config = JSON.parse(jsonStr);
    const env: Record<string, string> = config?.env || {};
    switch (providerType) {
      case "anthropic":
        return { apiKey: env["ANTHROPIC_API_KEY"] || "", baseUrl: env["ANTHROPIC_BASE_URL"] || "" };
      case "bedrock":
        return { region: env["AWS_REGION"] || "", awsProfile: env["AWS_PROFILE"] || "" };
      case "vertex":
        return { region: env["CLOUD_ML_REGION"] || "", projectId: env["ANTHROPIC_VERTEX_PROJECT_ID"] || "" };
      case "proxy":
        return { apiKey: env["ANTHROPIC_API_KEY"] || "", baseUrl: env["ANTHROPIC_BASE_URL"] || "" };
      case "open_ai":
        return { apiKey: env["CODEX_API_KEY"] || "", baseUrl: env["OPENAI_BASE_URL"] || "" };
      case "gemini":
        return { apiKey: env["GEMINI_API_KEY"] || "", baseUrl: env["GEMINI_API_BASE"] || "" };
      case "opencode":
        return { apiKey: env["OPENAI_API_KEY"] || "", baseUrl: env["OPENAI_BASE_URL"] || "" };
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** 根据当前 Tab 推导手动创建时的默认 ProviderType */
function defaultProviderTypeForTab(tab?: KnownCliTool): ProviderType {
  switch (tab) {
    case "codex": return "open_ai";
    case "gemini": return "gemini";
    case "opencode": return "opencode";
    default: return "anthropic";
  }
}

interface ProviderFormPanelProps {
  editProvider?: Provider | null;
  preset?: ProviderPreset | null;
  activeTab?: KnownCliTool;
  onBack: () => void;
}

export default function ProviderFormPanel({ editProvider, preset, activeTab, onBack }: ProviderFormPanelProps) {
  const { t } = useTranslation(["settings", "common"]);
  const providers = useProvidersStore((s) => s.providers);
  const addProvider = useProvidersStore((s) => s.addProvider);
  const updateProvider = useProvidersStore((s) => s.updateProvider);

  const isEditMode = !!editProvider;
  const isPresetMode = !!preset && !editProvider;

  const [form, setForm] = useState<FormState>(() => {
    if (editProvider) {
      return {
        name: editProvider.name,
        providerType: editProvider.providerType,
        apiKey: editProvider.apiKey || "",
        baseUrl: editProvider.baseUrl || "",
        region: editProvider.region || "",
        projectId: editProvider.projectId || "",
        awsProfile: editProvider.awsProfile || "",
        configDir: editProvider.configDir || "",
      };
    }
    if (preset) {
      return {
        ...emptyForm,
        name: t(preset.nameKey as any),
        providerType: preset.providerType,
        baseUrl: preset.defaults.baseUrl || "",
        region: preset.defaults.region || "",
        projectId: preset.defaults.projectId || "",
        awsProfile: preset.defaults.awsProfile || "",
      };
    }
    return { ...emptyForm, providerType: defaultProviderTypeForTab(activeTab) };
  });

  const [configDirInfo, setConfigDirInfo] = useState<ConfigDirInfo | null>(null);
  const currentMeta = useMemo(() => PROVIDER_TYPE_META[form.providerType], [form.providerType]);

  // config_profile JSON 编辑器状态
  const [configFileContent, setConfigFileContent] = useState("");
  const [configFileOriginal, setConfigFileOriginal] = useState("");
  const configFileIsDirty = configFileContent !== configFileOriginal;
  const isConfigJsonFile = form.providerType === "config_profile" && isJsonFile(form.configDir);

  // 非 config_profile 的配置 JSON 编辑器状态
  const [configJson, setConfigJson] = useState(() =>
    form.providerType !== "config_profile" ? buildConfigJson(form) : "",
  );
  const isUpdatingRef = useRef(false);

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
    try {
      // 如果 config_profile 且 JSON 文件有修改，先写回文件
      if (isConfigJsonFile && configFileIsDirty) {
        await filesystemService.writeFile(form.configDir, configFileContent);
        setConfigFileOriginal(configFileContent);
        toast.success(t("jsonFileSaved"));
      }

      const provider: Provider = {
        id: editProvider?.id || crypto.randomUUID(),
        name: form.name.trim(),
        providerType: form.providerType,
        apiKey: form.apiKey || null,
        baseUrl: form.baseUrl || null,
        region: form.region || null,
        projectId: form.projectId || null,
        awsProfile: form.awsProfile || null,
        configDir: form.configDir || null,
        isDefault: false,
      };
      if (editProvider) {
        const existing = providers.find((p) => p.id === editProvider.id);
        if (existing) provider.isDefault = existing.isDefault;
        await updateProvider(provider);
        toast.success(t("providerUpdated"));
      } else {
        await addProvider(provider);
        toast.success(t("providerAdded"));
      }
      onBack();
    } catch (e) {
      toast.error(t("operationFailed", { error: String(e) }));
    }
  }

  async function handleBrowseConfigDir() {
    const selected = await open({ directory: true, multiple: false, title: t("selectConfigDir") });
    if (selected) {
      updateForm({ configDir: selected as string });
      loadConfigDirInfo(selected as string);
    }
  }

  async function handleBrowseConfigFile() {
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
      {/* Header */}
      <div
        className="flex items-center gap-3 px-6 py-4 shrink-0"
        style={{ borderBottom: "1px solid var(--app-border)" }}
      >
        <button
          className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-[var(--app-hover)] transition-colors"
          style={{ color: "var(--app-text-secondary)" }}
          onClick={onBack}
        >
          <ArrowLeft size={18} />
        </button>
        <span className="text-base font-semibold" style={{ color: "var(--app-text-primary)" }}>
          {isEditMode ? t("editProvider") : t("addProvider")}
        </span>
      </div>

      {/* Form */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-6 py-8">
          {/* Avatar preview + preset hint */}
          <div className="flex items-center gap-4 mb-8">
            <ProviderAvatar
              name={form.name || "?"}
              providerType={form.providerType}
              accentColor={accentColor}
              size={64}
            />
            <div>
              <div className="text-lg font-semibold" style={{ color: "var(--app-text-primary)" }}>
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

          <div className="flex flex-col gap-5">
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
                <select
                  value={form.providerType}
                  onChange={(e) => handleTypeChange(e.target.value as ProviderType)}
                  className="h-10 px-3 rounded-md text-sm outline-none"
                  style={{ border: "1px solid var(--app-border)", background: "var(--app-content)", color: "var(--app-text-primary)" }}
                >
                  {(activeTab ? getProviderTypesForTab(activeTab) : (Object.keys(PROVIDER_TYPE_META) as ProviderType[])).map((key) => (
                    <option key={key} value={key}>{t(PROVIDER_TYPE_META[key].labelKey)}</option>
                  ))}
                </select>
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
                    style={{ background: "var(--app-content)", border: "1px solid var(--app-border)" }}
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
                    <div className="flex items-center gap-2">
                      <Label className="text-xs font-medium">{t("jsonConfigFileContent")}</Label>
                      {configFileIsDirty && (
                        <Badge variant="outline" className="text-[9px] px-1.5 py-0">
                          {t("unsavedJsonChanges")}
                        </Badge>
                      )}
                    </div>
                    <Suspense fallback={<div className="h-48 rounded-md border animate-pulse" style={{ background: "var(--app-content)" }} />}>
                      <JsonEditor
                        value={configFileContent}
                        onChange={setConfigFileContent}
                        rows={16}
                      />
                    </Suspense>
                  </div>
                )}
              </div>
            )}

            {/* 非 config_profile 类型的配置 JSON 编辑器 */}
            {form.providerType !== "config_profile" && (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <Label className="text-xs font-medium">{t("jsonConfig")}</Label>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 text-[11px] hover:underline"
                    style={{ color: "var(--app-text-link, var(--app-accent))" }}
                    onClick={() => {
                      providerService.openPathInExplorer(
                        // 打开全局 settings.json（~/.claude/settings.json）
                        ""
                      ).catch(() => {});
                    }}
                    title={t("editGlobalConfig")}
                  >
                    <Settings size={11} />
                    {t("editGlobalConfig")}
                  </button>
                </div>
                <Suspense fallback={<div className="h-36 rounded-md border animate-pulse" style={{ background: "var(--app-content)" }} />}>
                  <JsonEditor
                    value={configJson}
                    onChange={handleConfigJsonChange}
                    rows={8}
                  />
                </Suspense>
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-3 mt-8 pt-6" style={{ borderTop: "1px solid var(--app-border)" }}>
            <Button variant="secondary" size="default" onClick={onBack}>
              {t("common:cancel")}
            </Button>
            <Button size="default" onClick={handleSave}>
              {t("common:save")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
