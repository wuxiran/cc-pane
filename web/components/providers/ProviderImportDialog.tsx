// 从 cc-switch / Magpie 导入中转站：打开即读取来源 → 列出条目勾选 → 一次导入。
// 已存在的条目置灰不可勾；密钥不出后端，列表只显示「有无密钥」。
// cc-switch 的 Codex 完整 config.toml 会按层拆开：中转站片段 / 运行配置片段 / 上下文窗口 / YOLO / 模型。
// 已导入过的中转站若片段还空着，可选「补充原生配置」：只填空的，绝不覆盖已有内容。
// Magpie 路由组 / cc-switch 本地代理导入成指向本地网关的中转站，行内说明路由方式与依赖。
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { CheckboxRow } from "@/components/ui/CheckboxRow";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toastErr, toastOk } from "@/lib/feedback";
import { providerService } from "@/services/providerService";
import { useLaunchProfilesStore, useProvidersStore } from "@/stores";
import type { ExternalProviderCandidate, ExternalProviderPreview, ExternalProviderSource, Provider, ProviderType } from "@/types/provider";
import {
  hasProfileForProvider,
  importedProfileDraft,
  profilesMissingFragment,
  supplementedProfileDraft,
} from "./launchProfileImport";

type CandidateState = "new" | "needsProfile" | "supplement" | "exists";

const FAMILY_LABEL: Partial<Record<ProviderType, string>> = {
  anthropic: "Claude",
  proxy: "Claude",
  open_ai: "Codex",
  gemini: "Gemini",
  opencode: "OpenCode",
};

interface ProviderImportDialogProps {
  /** null = 关闭 */
  source: ExternalProviderSource | null;
  onClose: () => void;
}

export default function ProviderImportDialog({ source, onClose }: ProviderImportDialogProps) {
  const { t } = useTranslation(["providers", "common"]);
  const importProviders = useProvidersStore((s) => s.importExternalProviders);
  const providers = useProvidersStore((s) => s.providers);
  const profiles = useLaunchProfilesStore((s) => s.profiles);
  const createProfile = useLaunchProfilesStore((s) => s.create);
  const updateProfile = useLaunchProfilesStore((s) => s.update);
  const supplementProviders = useProvidersStore((s) => s.supplementExternalProviders);
  const nativeSummary = useNativeSummary();
  const [preview, setPreview] = useState<ExternalProviderPreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // null = 还没按状态算默认勾选（预览刚到）
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    if (!source) return;
    let cancelled = false;
    setPreview(null);
    setLoadError(null);
    setSelected(null);
    providerService.previewExternalProviders(source)
      .then((result) => {
        if (cancelled) return;
        setPreview(result);
        setSelected(null);
      })
      .catch((error) => {
        if (!cancelled) setLoadError(String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [source]);

  const sourceName = source ? t(`importSourceName.${source}`) : "";
  // 四种状态：新的（导入中转站 + 建运行配置）/ 中转站已在但还没运行配置（只补建运行配置）/
  // 都在但原生配置还空着（补充原生配置）/ 都在且无可补（不能勾）
  const stateOf = useMemo(() => {
    const map = new Map<string, CandidateState>();
    for (const item of preview?.candidates ?? []) {
      if (!item.duplicate) {
        map.set(item.key, "new");
        continue;
      }
      const provider = findProvider(providers, item);
      if (!provider) map.set(item.key, "exists");
      else if (!hasProfileForProvider(profiles, provider)) map.set(item.key, "needsProfile");
      else if (item.canSupplementProvider || profilesMissingFragment(profiles, provider, item.profile).length > 0) map.set(item.key, "supplement");
      else map.set(item.key, "exists");
    }
    return map;
  }, [preview, profiles, providers]);
  const selectable = useMemo(
    () => (preview?.candidates ?? []).filter((item) => stateOf.get(item.key) !== "exists"),
    [preview, stateOf],
  );
  // 默认勾上所有能做点什么的条目
  const chosen = selected ?? new Set(selectable.map((item) => item.key));
  const allSelected = selectable.length > 0 && selectable.every((item) => chosen.has(item.key));
  const skipped = (preview?.skippedEmpty ?? 0) + (preview?.skippedUnsupported ?? 0);
  // 「已存在」要说清在哪：中转站下拉按当前智能体筛选，别的智能体的条目在那里看不到
  const duplicateSummary = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of preview?.candidates ?? []) {
      if (stateOf.get(item.key) !== "exists") continue;
      const family = FAMILY_LABEL[item.providerType] ?? item.providerType;
      counts.set(family, (counts.get(family) ?? 0) + 1);
    }
    const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
    if (total === 0) return null;
    return {
      total,
      breakdown: [...counts.entries()].map(([family, n]) => t("importDialog.familyCount", { family, count: n })).join(t("importDialog.familySeparator")),
    };
  }, [preview, stateOf, t]);

  const toggle = (key: string, checked: boolean) => setSelected(() => {
    const next = new Set(chosen);
    if (checked) next.add(key);
    else next.delete(key);
    return next;
  });

  const submit = async () => {
    if (!source || chosen.size === 0 || importing || !preview) return;
    setImporting(true);
    try {
      const picked = preview.candidates.filter((item) => chosen.has(item.key));
      const newKeys = picked.filter((item) => stateOf.get(item.key) === "new").map((item) => item.key);
      const report = newKeys.length > 0 ? await importProviders(source, newKeys) : null;
      // 已存在的中转站：只把空着的片段 / 上下文窗口补上
      const supplementKeys = picked
        .filter((item) => stateOf.get(item.key) !== "new" && item.canSupplementProvider)
        .map((item) => item.key);
      let supplemented = supplementKeys.length > 0 ? await supplementProviders(source, supplementKeys) : 0;
      // 导入后供应商列表已重载：按名称 + 类型找回每条，给还没有运行配置的建一条；已有的只补空片段
      const freshProviders = useProvidersStore.getState().providers;
      let freshProfiles = useLaunchProfilesStore.getState().profiles;
      let created = 0;
      for (const item of picked) {
        const provider = findProvider(freshProviders, item);
        if (!provider) continue;
        if (hasProfileForProvider(freshProfiles, provider)) {
          if (stateOf.get(item.key) !== "supplement" || !item.profile) continue;
          for (const existing of profilesMissingFragment(freshProfiles, provider, item.profile)) {
            const draft = supplementedProfileDraft(existing, item.profile);
            if (!draft) continue;
            await updateProfile(existing.id, draft);
            supplemented += 1;
          }
          freshProfiles = useLaunchProfilesStore.getState().profiles;
          continue;
        }
        const draft = importedProfileDraft(provider, t("importDialog.profileDescription", { source: sourceName }), t, item.profile);
        if (!draft) continue;
        const profile = await createProfile(draft);
        freshProfiles = [...freshProfiles, profile];
        created += 1;
      }
      toastOk(supplemented > 0
        ? t("importDialog.doneSupplement", { imported: report?.imported ?? 0, profiles: created, supplemented })
        : t("importDialog.done", { imported: report?.imported ?? 0, profiles: created }));
      onClose();
    } catch (error) {
      toastErr(t("importDialog.failed", { error: String(error) }));
    } finally {
      setImporting(false);
    }
  };

  return (
    <Dialog open={source !== null} onOpenChange={(open) => { if (!open && !importing) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("importDialog.title", { source: sourceName })}</DialogTitle>
          <DialogDescription>{t("importDialog.description")}</DialogDescription>
        </DialogHeader>

        <div className="min-h-24">
          {loadError ? (
            <p className="text-sm text-[var(--app-status-danger)]">{t("importDialog.previewFailed", { error: loadError })}</p>
          ) : !preview ? (
            <p className="flex items-center gap-2 text-sm" style={{ color: "var(--app-text-tertiary)" }}>
              <Loader2 size={14} className="animate-spin" /> {t("importDialog.loading")}
            </p>
          ) : !preview.available ? (
            <p data-testid="import-source-missing" className="text-sm" style={{ color: "var(--app-text-tertiary)" }}>
              {t("importDialog.notFound", { source: sourceName, path: preview.path ?? "" })}
            </p>
          ) : preview.candidates.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--app-text-tertiary)" }}>
              {t("importDialog.empty", { source: sourceName })}
            </p>
          ) : (
            <div className="space-y-2">
              {duplicateSummary && (
                <p
                  data-testid="import-duplicate-summary"
                  className="rounded-md border border-[var(--app-border)] bg-[var(--app-hover)] px-3 py-2 text-xs leading-5"
                  style={{ color: "var(--app-text-secondary)" }}
                >
                  {t(duplicateSummary.total === preview.candidates.length ? "importDialog.allExist" : "importDialog.someExist", {
                    count: duplicateSummary.total,
                    breakdown: duplicateSummary.breakdown,
                  })}
                </p>
              )}
              <label className="flex items-center gap-2 px-1 text-xs" style={{ color: "var(--app-text-secondary)" }}>
                <Checkbox
                  checked={allSelected}
                  disabled={selectable.length === 0}
                  onCheckedChange={(checked) => setSelected(checked === true ? new Set(selectable.map((item) => item.key)) : new Set())}
                />
                {t("importDialog.selectAll", { count: selectable.length })}
              </label>
              <div className="app-scrollbar max-h-80 space-y-1.5 overflow-y-auto pr-1">
                {preview.candidates.map((item) => {
                  const state = stateOf.get(item.key) ?? "exists";
                  const meta = state === "exists"
                    ? t("importDialog.duplicate")
                    : state === "needsProfile"
                      ? t("importDialog.needsProfile")
                      : state === "supplement"
                        ? t("importDialog.supplement")
                        : [
                            item.hasKey ? null : t("importDialog.noKey"),
                            item.modelCount > 0 ? t("importDialog.models", { count: item.modelCount }) : null,
                          ].filter(Boolean).join(" · ") || undefined;
                  const native = nativeSummary(item);
                  return (
                  <CheckboxRow
                    key={item.key}
                    checked={state !== "exists" && chosen.has(item.key)}
                    disabled={state === "exists"}
                    onCheckedChange={(checked) => toggle(item.key, checked)}
                    label={item.name}
                    description={(
                      <>
                        {[FAMILY_LABEL[item.providerType] ?? item.providerType, item.baseUrl].filter(Boolean).join(" · ")}
                        {item.relay ? <RelaySummary relay={item.relay} /> : null}
                        {native && state !== "exists" ? <span className="block truncate" data-testid="import-native-summary">{native}</span> : null}
                        {state === "supplement" ? <span className="block">{t("importDialog.supplementDetail")}</span> : null}
                      </>
                    )}
                    trailing={meta}
                  />
                  );
                })}
              </div>
            </div>
          )}
          {preview?.available && (preview.skippedItems?.length ?? 0) > 0 && (
            <ul data-testid="import-skipped-items" className="mt-2 space-y-0.5 text-[length:var(--text-caption)]" style={{ color: "var(--app-text-tertiary)" }}>
              {(preview.skippedItems ?? []).map((item) => (
                <li key={`${item.name}:${item.reason}`} title={item.reason}>
                  {t("importDialog.skippedPlaceholder", { name: item.name })}
                </li>
              ))}
            </ul>
          )}
          {preview?.available && (skipped > 0 || preview.unsupportedLogins > 0) && (
            <p className="mt-2 text-[length:var(--text-caption)]" style={{ color: "var(--app-text-tertiary)" }}>
              {[
                skipped > 0 ? t("importDialog.skipped", { count: skipped }) : null,
                preview.unsupportedLogins > 0 ? t("importDialog.logins", { count: preview.unsupportedLogins }) : null,
              ].filter(Boolean).join(" ")}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose} disabled={importing}>
            {t("common:cancel")}
          </Button>
          <Button size="sm" onClick={() => void submit()} disabled={chosen.size === 0 || importing}>
            {importing ? t("importDialog.importing") : t("importDialog.submit", { count: chosen.size })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 依赖本地网关的条目：路由组「路由组 · <routing> · N 成员」/ 本地代理，外加依赖说明。 */
function RelaySummary({ relay }: { relay: NonNullable<ExternalProviderCandidate["relay"]> }) {
  const { t } = useTranslation("providers");
  const isGroup = relay.kind === "magpie_group";
  const headline = isGroup
    ? t("importDialog.relayGroup", { routing: relay.routing ?? "smart", count: relay.memberCount ?? 0 })
    : relay.memberCount
      ? t("importDialog.relayProxyFailover", { count: relay.memberCount })
      : t("importDialog.relayProxy");
  const note = isGroup ? t("importDialog.relayGroupNote") : t("importDialog.relayProxyNote");
  return (
    <span className="block" data-testid="import-relay-summary">
      <span className="block truncate">{headline}</span>
      <span className="block truncate" style={{ color: "var(--app-text-tertiary)" }}>{note}</span>
    </span>
  );
}

/** 预览条目对应的已存在供应商：后端认定的那一条，退回同名同类型。 */
function findProvider(providers: readonly Provider[], item: ExternalProviderCandidate): Provider | undefined {
  return (item.existingProviderId ? providers.find((provider) => provider.id === item.existingProviderId) : undefined)
    ?? providers.find((provider) => provider.name === item.name && provider.providerType === item.providerType);
}

/** 条目里拆出来的原生配置一行摘要（不含密钥）：哪些层有内容 + 没导入的键。 */
function useNativeSummary() {
  const { t } = useTranslation("providers");
  return (item: ExternalProviderCandidate): string | null => nativeSummaryText(item, t);
}

function nativeSummaryText(item: ExternalProviderCandidate, t: ReturnType<typeof useTranslation<"providers">>["t"]): string | null {
  const parts = [
    item.hasProviderNativeOverride ? t("importDialog.nativeProvider") : null,
    item.profile?.nativeOverride ? t("importDialog.nativeProfile") : null,
    item.profile?.yoloMode ? t("importDialog.nativeYolo") : null,
    item.contextWindowTokens ? t("importDialog.nativeContext", { tokens: item.contextWindowTokens.toLocaleString() }) : null,
  ].filter(Boolean);
  const dropped = item.profile?.droppedKeys ?? [];
  const lines = [
    parts.length > 0 ? t("importDialog.nativeSummary", { parts: parts.join(" · ") }) : null,
    dropped.length > 0 ? t("importDialog.dropped", { keys: dropped.join(", ") }) : null,
  ].filter(Boolean);
  return lines.length > 0 ? lines.join(" · ") : null;
}
