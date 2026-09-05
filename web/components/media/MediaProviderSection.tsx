import { useEffect, useMemo, useState } from "react";
import { Check, KeyRound, Link2, ListRestart, LoaderCircle, Plus, Save } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toastErr, toastOk } from "@/lib/feedback";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useProvidersStore } from "@/stores";
import { mediaService } from "@/services/mediaService";
import { providerService } from "@/services/providerService";
import { SYSTEM_PROVIDER_ID, type Provider, type ProviderModel } from "@/types/provider";
import type { MediaProviderCapabilities, MediaProtocol } from "@/types/media";
import { getErrorMessage } from "@/utils";

interface MediaProviderSectionProps {
  providerId: string | null;
  modelId: string | null;
  protocol: MediaProtocol;
  capabilities?: MediaProviderCapabilities | null;
  onProviderChange: (providerId: string | null) => void;
  onModelChange: (modelId: string | null) => void;
  onProtocolChange: (protocol: MediaProtocol) => void;
  onSaved?: (provider: Provider) => void;
}

function modelText(provider: Provider | null): string {
  return provider?.models?.map((model) => model.id).join(", ") ?? "";
}

function normalizeModels(value: string): ProviderModel[] {
  return [...new Set(value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean))].map((id) => ({ id }));
}

const LOCAL_COMFY_PROVIDER_ID = "comfy-local";

export default function MediaProviderSection({
  providerId,
  modelId,
  protocol,
  capabilities = null,
  onProviderChange,
  onModelChange,
  onProtocolChange,
  onSaved,
}: MediaProviderSectionProps) {
  const { t } = useTranslation("media");
  const providers = useProvidersStore((state) => state.providers);
  const loadProviders = useProvidersStore((state) => state.loadProviders);
  // 媒体 Provider 是独立的 `media` 类型：这里只展示媒体 Provider，
  // LLM Provider 不再混进来（docs/99 B1）。
  const selectableProviders = useMemo(
    () => providers.filter((provider) => provider.providerType === "media"
      && provider.id !== SYSTEM_PROVIDER_ID
      && provider.id !== LOCAL_COMFY_PROVIDER_ID),
    [providers],
  );
  const selectedProvider = selectableProviders.find((provider) => provider.id === providerId) ?? null;
  const [name, setName] = useState(() => t("defaultProviderName"));
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiKeyDirty, setApiKeyDirty] = useState(false);
  const [models, setModels] = useState("");
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);

  useEffect(() => { void loadProviders(); }, [loadProviders]);

  useEffect(() => {
    if (!selectedProvider || editing) return;
    setName(selectedProvider.name);
    setBaseUrl(selectedProvider.baseUrl ?? "");
    setApiKey(selectedProvider.apiKey ?? "");
    setApiKeyDirty(false);
    setModels(modelText(selectedProvider));
  }, [editing, selectedProvider]);

  useEffect(() => {
    if (editing || providerId || !selectableProviders[0]) return;
    onProviderChange(selectableProviders[0].id);
  }, [editing, onProviderChange, providerId, selectableProviders]);

  // Older sessions could persist the removed local-engine sentinel. Migrate
  // it to the first configured cloud provider while keeping the selected
  // ComfyUI protocol, since remote ComfyUI workflows remain supported.
  useEffect(() => {
    if (providerId !== LOCAL_COMFY_PROVIDER_ID) return;
    const fallback = selectableProviders[0];
    onProviderChange(fallback?.id ?? null);
    onModelChange(null);
  }, [onModelChange, onProviderChange, providerId, selectableProviders]);

  const modelOptions = useMemo(() => normalizeModels(models), [models]);
  const effectiveModel = modelId && modelOptions.some((model) => model.id === modelId)
    ? modelId
    : selectedProvider?.defaultModelId && modelOptions.some((model) => model.id === selectedProvider.defaultModelId)
      ? selectedProvider.defaultModelId
    : modelOptions[0]?.id ?? null;

  const capabilityOperationLabels = capabilities?.operations.map((operation) =>
    t(operation === "textToImage" ? "textToImage" : operation === "imageToImage" ? "imageToImage" : operation === "textToVideo" ? "textToVideo" : operation === "imageToVideo" ? "imageToVideo" : operation === "upscale" ? "imageUpscale" : operation === "extend" ? "videoExtend" : "imageEdit"),
  ) ?? [];

  useEffect(() => {
    if (effectiveModel !== modelId) onModelChange(effectiveModel);
  }, [effectiveModel, modelId, onModelChange]);

  async function saveProvider() {
    const trimmedName = name.trim() || t("defaultProviderName");
    const parsedModels = normalizeModels(models);
    if (!baseUrl.trim()) {
      toastErr(t("providerUrlRequired"));
      return;
    }
    setSaving(true);
    try {
      const saved: Provider = {
        id: selectedProvider && selectedProvider.id !== SYSTEM_PROVIDER_ID ? selectedProvider.id : crypto.randomUUID(),
        name: trimmedName,
        providerType: "media",
        // Keep an existing secret when the provider API returns a redacted or
        // empty value and the user did not explicitly edit the key field.
        apiKey: apiKeyDirty || !selectedProvider
          ? apiKey.trim() || null
          : selectedProvider.apiKey ?? null,
        baseUrl: baseUrl.trim(),
        models: parsedModels,
        defaultModelId: parsedModels[0]?.id ?? null,
        isDefault: selectedProvider?.isDefault ?? false,
      };
      if (selectedProvider && selectedProvider.id !== SYSTEM_PROVIDER_ID) {
        await providerService.updateProvider(saved);
      } else {
        await providerService.addProvider(saved);
      }
      await loadProviders();
      onProviderChange(saved.id);
      onModelChange(parsedModels[0]?.id ?? null);
      onSaved?.(saved);
      setEditing(false);
      toastOk(t("providerSaved"));
    } catch (error) {
      toastErr(t("providerSaveFailed", { message: getErrorMessage(error) }));
    } finally {
      setSaving(false);
    }
  }

  async function fetchModels() {
    if (!baseUrl.trim()) {
      toastErr(t("providerUrlRequired"));
      return;
    }
    setFetchingModels(true);
    try {
      // Explicit form values win; the saved provider fills in a stored key
      // when the (possibly redacted) key field was not touched.
      const ids = await mediaService.listProviderModels({
        baseUrl: baseUrl.trim(),
        apiKey: apiKeyDirty || !selectedProvider ? apiKey.trim() || undefined : undefined,
        providerId: selectedProvider?.id,
      });
      setModels(ids.join(", "));
      setEditing(true);
      toastOk(t("modelsFetched", { count: ids.length }));
    } catch (error) {
      toastErr(t("fetchModelsFailed", { message: getErrorMessage(error) }));
    } finally {
      setFetchingModels(false);
    }
  }

  function startNew() {
    onProviderChange(null);
    onModelChange(null);
    setName(t("defaultProviderName"));
    setBaseUrl("");
    setApiKey("");
    setApiKeyDirty(true);
    setModels("");
    setEditing(true);
  }

  return (
    <section className="space-y-3 border-b border-[var(--app-border)] px-3 py-3" data-testid="media-provider-section">
      <div className="flex items-center justify-between">
        <div><h2 className="text-xs font-semibold" style={{ color: "var(--app-text-primary)" }}>{t("providerSectionTitle")}</h2><p className="mt-0.5 text-[10px]" style={{ color: "var(--app-text-tertiary)" }}>{t("providerSectionDescription")}</p></div>
        <Button type="button" variant="ghost" size="icon-xs" aria-label={t("newProvider")} title={t("newProvider")} onClick={startNew}><Plus aria-hidden="true" /></Button>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="media-provider-select" className="text-[11px]">{t("provider")}</Label>
        <Select
          value={providerId === LOCAL_COMFY_PROVIDER_ID ? "__new__" : providerId ?? "__new__"}
          onValueChange={(value) => {
            if (value === "__new__") {
              startNew();
              return;
            }
            onProviderChange(value);
            setEditing(false);
          }}
        >
          <SelectTrigger id="media-provider-select" size="sm">
            <SelectValue placeholder={t("selectProvider")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__new__">{t("newProviderOption")}</SelectItem>
            {selectableProviders.map((provider) => <SelectItem key={provider.id} value={provider.id}>{provider.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <div className="space-y-1.5">
          <Label htmlFor="media-provider-protocol" className="text-[11px]">{t("protocol")}</Label>
          <Select value={protocol} onValueChange={(value) => onProtocolChange(value as MediaProtocol)}>
            <SelectTrigger id="media-provider-protocol" size="sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="sub2api">{t("protocolSub2Api")}</SelectItem>
              <SelectItem value="open_ai_compatible">{t("protocolOpenAi")}</SelectItem>
              <SelectItem value="comfyui">{t("protocolComfy")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="media-provider-url" className="text-[11px]">{t("url")}</Label>
          <div className="relative">
            <Link2 className="pointer-events-none absolute left-2.5 top-2 size-3.5" style={{ color: "var(--app-text-tertiary)" }} aria-hidden="true" />
            <Input
              id="media-provider-url"
              className="pl-8"
              value={baseUrl}
              onChange={(event) => { setBaseUrl(event.target.value); setEditing(true); }}
              placeholder={protocol === "comfyui" ? "https://comfy.example.com" : protocol === "sub2api" ? "https://hub.nocannobb.com" : "https://api.example.com/v1"}
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="media-provider-key" className="text-[11px]">{t("apiKey")}</Label>
          <div className="relative">
            <KeyRound className="pointer-events-none absolute left-2.5 top-2 size-3.5" style={{ color: "var(--app-text-tertiary)" }} aria-hidden="true" />
            <Input id="media-provider-key" className="pl-8" type="password" value={apiKey} onChange={(event) => { setApiKey(event.target.value); setApiKeyDirty(true); setEditing(true); }} placeholder="sk-..." autoComplete="off" />
          </div>
        </div>
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="media-provider-models" className="text-[11px]">{t("models")}</Label>
            {protocol !== "comfyui" ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="h-5 gap-1 px-1.5 text-[10px]"
                disabled={fetchingModels || !baseUrl.trim()}
                onClick={() => void fetchModels()}
                data-testid="media-provider-fetch-models"
              >
                {fetchingModels ? <LoaderCircle className="size-3 animate-spin" aria-hidden="true" /> : <ListRestart className="size-3" aria-hidden="true" />}
                {fetchingModels ? t("fetchingModels") : t("fetchModels")}
              </Button>
            ) : null}
          </div>
          <Input id="media-provider-models" value={models} onChange={(event) => { setModels(event.target.value); setEditing(true); }} placeholder={protocol === "comfyui" ? "workflow" : protocol === "sub2api" ? "gpt-image-2, seedance-2.0, wan3.0-video" : "gpt-image-1, sora-2"} />
        </div>
        {modelOptions.length > 0 ? <div className="space-y-1.5"><Label htmlFor="media-provider-model" className="text-[11px]">{t("currentModel")}</Label><Select value={effectiveModel ?? "__none__"} onValueChange={(value) => onModelChange(value === "__none__" ? null : value)}><SelectTrigger id="media-provider-model" size="sm"><SelectValue placeholder={t("selectModel")} /></SelectTrigger><SelectContent><SelectItem value="__none__">{t("noModel")}</SelectItem>{modelOptions.map((model) => <SelectItem key={model.id} value={model.id}>{model.label || model.id}</SelectItem>)}</SelectContent></Select></div> : null}
      </div>
      <Button type="button" className="w-full" size="sm" disabled={saving || !baseUrl.trim()} onClick={() => void saveProvider()}><Save aria-hidden="true" />{saving ? t("saving") : editing || !selectedProvider ? t("saveProvider") : t("saveConfig")}</Button>
      {selectedProvider && !editing ? <div className="flex items-center gap-1 text-[10px]" style={{ color: "var(--app-status-success)" }}><Check className="size-3" aria-hidden="true" />{t("loadedProvider", { name: selectedProvider.name })}</div> : null}
      {capabilities ? <div className="space-y-1.5 border-t border-[var(--app-border)] pt-2" data-testid="media-provider-capabilities">
        <div className="flex items-center justify-between gap-2 text-[10px]" style={{ color: "var(--app-text-tertiary)" }}>
          <span>{t("capabilityProtocol", { protocol: capabilities.protocol })}</span>
          <span>{capabilities.supportsAsyncJobs ? t("capabilityAsync") : t("capabilitySync")}</span>
        </div>
        <div className="flex flex-wrap gap-1">
          {capabilityOperationLabels.map((label) => <span key={label} className="rounded border border-[var(--app-border)] px-1.5 py-0.5 text-[9px]" style={{ color: "var(--app-text-secondary)" }}>{label}</span>)}
          {capabilities.supportsCancel ? <span className="rounded border border-[var(--app-status-success)]/40 px-1.5 py-0.5 text-[9px]" style={{ color: "var(--app-status-success)" }}>{t("capabilityCancel")}</span> : null}
        </div>
      </div> : null}
    </section>
  );
}
