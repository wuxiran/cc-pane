import { useState, useEffect, useMemo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Plus, Trash2, Star, Pencil, FolderOpen, FileText, ExternalLink, Play } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useProvidersStore, useWorkspacesStore, useDialogStore } from "@/stores";
import { PROVIDER_TYPE_META, type Provider, type ProviderType, type ConfigDirInfo } from "@/types/provider";
import { providerService } from "@/services/providerService";

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

export default function ProviderSection() {
  const { t } = useTranslation(["settings", "common"]);
  const providers = useProvidersStore((s) => s.providers);
  const loadProviders = useProvidersStore((s) => s.loadProviders);
  const addProvider = useProvidersStore((s) => s.addProvider);
  const updateProvider = useProvidersStore((s) => s.updateProvider);
  const removeProvider = useProvidersStore((s) => s.removeProvider);
  const setDefault = useProvidersStore((s) => s.setDefault);

  const [editing, setEditing] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>({ ...emptyForm });
  const [configDirInfo, setConfigDirInfo] = useState<ConfigDirInfo | null>(null);

  const currentMeta = useMemo(() => PROVIDER_TYPE_META[form.providerType], [form.providerType]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadProviders(); }, []);

  const loadConfigDirInfo = useCallback(async (dir: string) => {
    if (!dir) { setConfigDirInfo(null); return; }
    try {
      const info = await providerService.readConfigDirInfo(dir);
      setConfigDirInfo(info);
    } catch {
      setConfigDirInfo(null);
    }
  }, []);

  function resetForm() {
    setForm({ ...emptyForm });
    setEditing(false);
    setEditingId(null);
    setConfigDirInfo(null);
  }

  function handleNew() {
    resetForm();
    setEditing(true);
  }

  function handleEdit(p: Provider) {
    setEditingId(p.id);
    const configDir = p.configDir || "";
    setForm({
      name: p.name,
      providerType: p.providerType,
      apiKey: p.apiKey || "",
      baseUrl: p.baseUrl || "",
      region: p.region || "",
      projectId: p.projectId || "",
      awsProfile: p.awsProfile || "",
      configDir,
    });
    setEditing(true);
    if (configDir) loadConfigDirInfo(configDir);
  }

  async function handleSave() {
    if (!form.name.trim()) { toast.error(t("nameRequired")); return; }
    try {
      const provider: Provider = {
        id: editingId || crypto.randomUUID(),
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
      if (editingId) {
        const existing = providers.find((p) => p.id === editingId);
        if (existing) provider.isDefault = existing.isDefault;
        await updateProvider(provider);
        toast.success(t("providerUpdated"));
      } else {
        await addProvider(provider);
        toast.success(t("providerAdded"));
      }
      resetForm();
    } catch (e) {
      toast.error(t("operationFailed", { error: String(e) }));
    }
  }

  async function handleRemove(id: string) {
    try { await removeProvider(id); toast.success(t("providerDeleted")); } catch (e) { toast.error(t("deleteFailed", { error: String(e) })); }
  }

  async function handleSetDefault(id: string) {
    try { await setDefault(id); toast.success(t("setAsDefault")); } catch (e) { toast.error(t("setDefaultFailed", { error: String(e) })); }
  }

  function handleLaunchWithProvider(providerId: string) {
    const ws = useWorkspacesStore.getState().selectedWorkspace();
    if (!ws || ws.projects.length === 0) {
      toast.error(t("selectWorkspaceFirst"));
      return;
    }
    useDialogStore.getState().setPendingLaunch({
      path: ws.projects[0].path,
      workspaceName: ws.name,
      providerId,
      workspacePath: ws.path,
    });
    useDialogStore.getState().closeSettings();
  }

  function getTypeLabel(pt: ProviderType): string {
    const meta = PROVIDER_TYPE_META[pt];
    return meta ? t(meta.labelKey) : pt;
  }

  function updateForm(partial: Partial<FormState>) {
    setForm((prev) => ({ ...prev, ...partial }));
  }

  // 切换类型时清空不相关字段
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

  async function handleBrowseConfigDir() {
    const selected = await open({ directory: true, multiple: false, title: t("selectConfigDir") });
    if (selected) {
      updateForm({ configDir: selected as string });
      loadConfigDirInfo(selected as string);
    }
  }

  async function handleBrowseConfigFile() {
    const selected = await open({
      directory: false,
      multiple: false,
      title: t("selectCcswitchFile"),
      filters: [{ name: t("jsonFiles"), extensions: ["json"] }],
    });
    if (selected) {
      updateForm({ configDir: selected as string });
      loadConfigDirInfo(selected as string);
    }
  }

  async function handleOpenInExplorer(path: string) {
    try {
      await providerService.openPathInExplorer(path);
    } catch (e) {
      toast.error(t("openFailed", { error: String(e) }));
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-[15px] font-semibold mb-1" style={{ color: "var(--app-text-primary)" }}>
        {t("providerTitle")}
      </h3>
      <p className="text-xs mb-1" style={{ color: "var(--app-text-tertiary)" }}>
        {t("providerDesc")}
      </p>

      {/* Provider 列表 */}
      <div className="flex flex-col gap-1.5">
        {providers.map((p) => (
          <div
            key={p.id}
            className="flex items-center justify-between px-3 py-2.5 rounded-md"
            style={{ background: "var(--app-content)", border: "1px solid var(--app-border)" }}
          >
            <div className="flex flex-col gap-0.5">
              <div className="flex items-center gap-1.5 text-[13px] font-medium" style={{ color: "var(--app-text-primary)" }}>
                {p.name}
                {p.isDefault && <Badge variant="secondary" className="text-[10px] px-1.5 py-0">{t("defaultBadge")}</Badge>}
              </div>
              <div className="text-[11px]" style={{ color: "var(--app-text-tertiary)" }}>
                {getTypeLabel(p.providerType)}
                {p.providerType === "config_profile" && p.configDir && (
                  <span className="ml-1.5 opacity-70" title={p.configDir}>
                    · {p.configDir.length > 40 ? `...${p.configDir.slice(-37)}` : p.configDir}
                  </span>
                )}
              </div>
            </div>
            <div className="flex gap-0.5">
              <Button variant="ghost" size="sm" onClick={() => handleLaunchWithProvider(p.id)} title={t("provider")}><Play size={14} /></Button>
              {!p.isDefault && (
                <Button variant="ghost" size="sm" onClick={() => handleSetDefault(p.id)} title={t("setAsDefaultBtn")}><Star size={14} /></Button>
              )}
              <Button variant="ghost" size="sm" onClick={() => handleEdit(p)} title={t("editBtn")}><Pencil size={14} /></Button>
              <Button variant="ghost" size="sm" className="text-destructive" onClick={() => handleRemove(p.id)} title={t("deleteBtn")}><Trash2 size={14} /></Button>
            </div>
          </div>
        ))}
        {providers.length === 0 && (
          <div className="text-xs text-center py-4" style={{ color: "var(--app-text-tertiary)" }}>
            {t("noProviders")}
          </div>
        )}
      </div>

      {!editing && (
        <Button variant="outline" size="sm" onClick={handleNew}>
          <Plus size={14} className="mr-1" /> {t("addProvider")}
        </Button>
      )}

      {editing && (
        <div
          className="flex flex-col gap-2.5 p-3 rounded-md"
          style={{ background: "var(--app-hover)", border: "1px solid var(--app-border)" }}
        >
          <div className="text-[13px] font-semibold" style={{ color: "var(--app-text-primary)" }}>
            {editingId ? t("editProvider") : t("addProvider")}
          </div>

          <div className="flex flex-col gap-1">
            <Label>{t("providerName")}</Label>
            <Input value={form.name} onChange={(e) => updateForm({ name: e.target.value })} placeholder={t("providerNamePlaceholder")} />
          </div>

          <div className="flex flex-col gap-1">
            <Label>{t("providerType")}</Label>
            <select
              value={form.providerType}
              onChange={(e) => handleTypeChange(e.target.value as ProviderType)}
              className="h-9 px-2 rounded-md text-[13px] outline-none"
              style={{ border: "1px solid var(--app-border)", background: "var(--app-content)", color: "var(--app-text-primary)" }}
            >
              {Object.entries(PROVIDER_TYPE_META).map(([key, meta]) => (
                <option key={key} value={key}>{t(meta.labelKey)} - {t(meta.descriptionKey)}</option>
              ))}
            </select>
          </div>

          {currentMeta.fields.includes("apiKey") && (
            <div className="flex flex-col gap-1">
              <Label>{t("apiKey")}</Label>
              <Input type="password" value={form.apiKey} onChange={(e) => updateForm({ apiKey: e.target.value })} placeholder="sk-ant-..." />
            </div>
          )}
          {currentMeta.fields.includes("baseUrl") && (
            <div className="flex flex-col gap-1">
              <Label>{t("baseUrl")}</Label>
              <Input value={form.baseUrl} onChange={(e) => updateForm({ baseUrl: e.target.value })} placeholder="https://api.anthropic.com" />
            </div>
          )}
          {currentMeta.fields.includes("region") && (
            <div className="flex flex-col gap-1">
              <Label>{t("region")}</Label>
              <Input value={form.region} onChange={(e) => updateForm({ region: e.target.value })} placeholder={form.providerType === "bedrock" ? "us-east-1" : "us-central1"} />
            </div>
          )}
          {currentMeta.fields.includes("awsProfile") && (
            <div className="flex flex-col gap-1">
              <Label>{t("awsProfile")}</Label>
              <Input value={form.awsProfile} onChange={(e) => updateForm({ awsProfile: e.target.value })} placeholder="default" />
            </div>
          )}
          {currentMeta.fields.includes("projectId") && (
            <div className="flex flex-col gap-1">
              <Label>{t("vertexProjectId")}</Label>
              <Input value={form.projectId} onChange={(e) => updateForm({ projectId: e.target.value })} placeholder="my-gcp-project" />
            </div>
          )}

          {currentMeta.fields.includes("configDir") && (
            <div className="flex flex-col gap-1.5">
              <Label>{t("configPath")}</Label>
              <div className="flex gap-1.5">
                <Input
                  value={form.configDir}
                  onChange={(e) => {
                    updateForm({ configDir: e.target.value });
                    if (e.target.value) loadConfigDirInfo(e.target.value);
                    else setConfigDirInfo(null);
                  }}
                  placeholder={t("configPathPlaceholder")}
                  className="flex-1"
                />
                <Button variant="outline" size="sm" onClick={handleBrowseConfigDir} className="shrink-0" title={t("selectConfigDir")}>
                  <FolderOpen size={14} className="mr-1" /> {t("directory")}
                </Button>
                <Button variant="outline" size="sm" onClick={handleBrowseConfigFile} className="shrink-0" title={t("selectCcswitchFile")}>
                  <FileText size={14} className="mr-1" /> {t("file")}
                </Button>
              </div>

              {form.configDir && configDirInfo && (
                <div
                  className="flex flex-col gap-1.5 p-2.5 rounded text-[12px]"
                  style={{ background: "var(--app-content)", border: "1px solid var(--app-border)" }}
                >
                  <div className="flex flex-col gap-0.5">
                    {configDirInfo.files.map((f) => (
                      <div key={f} className="flex items-center gap-1.5" style={{ color: "var(--app-text-secondary)" }}>
                        <FileText size={12} className="shrink-0" />
                        <span>{f}</span>
                        {f === "settings.json" && (
                          <Badge variant={configDirInfo.hasSettings ? "secondary" : "destructive"} className="text-[9px] px-1 py-0 ml-auto">
                            {configDirInfo.hasSettings ? "✓" : "✗"}
                          </Badge>
                        )}
                        {f === ".credentials.json" && (
                          <Badge variant={configDirInfo.hasCredentials ? "secondary" : "destructive"} className="text-[9px] px-1 py-0 ml-auto">
                            {configDirInfo.hasCredentials ? "✓" : "✗"}
                          </Badge>
                        )}
                      </div>
                    ))}
                  </div>
                  {configDirInfo.settingsSummary && (
                    <div className="text-[11px] pt-1" style={{ color: "var(--app-text-tertiary)", borderTop: "1px solid var(--app-border)" }}>
                      {configDirInfo.settingsSummary}
                    </div>
                  )}
                  <div className="flex gap-1.5 pt-1" style={{ borderTop: "1px solid var(--app-border)" }}>
                    <Button variant="ghost" size="sm" className="h-6 text-[11px] px-2" onClick={() => handleOpenInExplorer(form.configDir)}>
                      <ExternalLink size={12} className="mr-1" /> {t("openDir")}
                    </Button>
                    {configDirInfo.hasSettings && (
                      <Button variant="ghost" size="sm" className="h-6 text-[11px] px-2" onClick={() => handleOpenInExplorer(form.configDir + "/settings.json")}>
                        <FileText size={12} className="mr-1" /> {t("editSettings")}
                      </Button>
                    )}
                  </div>
                </div>
              )}

              {form.configDir && !configDirInfo && (
                <div className="text-[11px] py-1" style={{ color: "var(--app-text-tertiary)" }}>
                  {t("pathNotExist")}
                </div>
              )}
            </div>
          )}

          <div className="flex justify-end gap-2 mt-1">
            <Button variant="secondary" size="sm" onClick={resetForm}>{t("common:cancel")}</Button>
            <Button size="sm" onClick={handleSave}>{t("common:save")}</Button>
          </div>
        </div>
      )}
    </div>
  );
}
