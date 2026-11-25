// 运行配置卡里的「原生配置」分段：运行配置这一层的片段 + 生效配置预览（每个键标出来源层）。
// 合并顺序：CLI 自己的配置 ← 中转站片段 ← 运行配置片段 ← CC-Panes 显式字段。
import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, FileCog } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useLaunchProfilesStore } from "@/stores";
import type { LaunchProfileDraft, NativeConfigPreview, NativeConfigSource, NativeOverrideTool } from "@/types";
import { isNativeOverrideTool } from "@/types/native-config";
import type { KnownCliTool } from "@/types/terminal";
import { Section } from "./launchProfileParts";
import NativeOverrideEditor, { useIssueText, withNativeOverride } from "./NativeOverrideEditor";
import NativeConfigQuickToggles from "./NativeConfigQuickToggles";

const PREVIEW_DELAY_MS = 300;
const RUNTIME_NAMES: Record<string, string> = { local: "Local", wsl: "WSL", ssh: "SSH" };

interface LaunchProfileNativeConfigCardProps {
  draft: LaunchProfileDraft;
  setDraft: Dispatch<SetStateAction<LaunchProfileDraft>>;
  activeTool: KnownCliTool;
}

interface NativeConfigBodyProps {
  draft: LaunchProfileDraft;
  setDraft: Dispatch<SetStateAction<LaunchProfileDraft>>;
  tool: NativeOverrideTool;
}

/** 只有支持原生配置覆盖的 CLI（Codex / Claude）才出这一段。 */
export default function LaunchProfileNativeConfigCard({ draft, setDraft, activeTool }: LaunchProfileNativeConfigCardProps) {
  return isNativeOverrideTool(activeTool) ? <NativeConfigSection draft={draft} setDraft={setDraft} tool={activeTool} /> : null;
}

/** 草稿变了 300ms 后取生效配置预览（按草稿算，不必先保存）。 */
function useNativeConfigPreview(draft: LaunchProfileDraft, tool: NativeOverrideTool, enabled: boolean) {
  const previewNativeConfig = useLaunchProfilesStore((s) => s.previewNativeConfig);
  const [preview, setPreview] = useState<NativeConfigPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      previewNativeConfig(draft, tool)
        .then((result) => {
          if (cancelled) return;
          setPreview(result);
          setError(null);
        })
        .catch((reason) => { if (!cancelled) setError(String(reason)); });
    }, PREVIEW_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [draft, tool, enabled, previewNativeConfig]);
  return { preview, error };
}

function NativeConfigSection({ draft, setDraft, tool }: NativeConfigBodyProps) {
  const { t } = useTranslation("providers");
  const fragment = draft.nativeOverrides?.[tool] ?? "";
  const [open, setOpen] = useState(() => fragment.trim() !== "");
  const { preview, error } = useNativeConfigPreview(draft, tool, open);
  const issueText = useIssueText();
  // 编辑器自己即时校验运行配置这一层；这里只补报中转站那一层的问题
  const providerIssues = (preview?.issues ?? []).filter((issue) => issue.layer === "provider");
  const notApplied = (preview?.runtimes ?? []).filter((runtime) => !runtime.applied);

  return (
    <Section
      id="launch-profile-section-native"
      title={t("nativeConfig.sectionTitle")}
      hint={t("nativeConfig.sectionHint")}
      icon={<FileCog size={14} />}
      headerActions={(
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-xs"
          aria-expanded={open}
          data-testid="native-config-toggle"
          onClick={() => setOpen((value) => !value)}
        >
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          {open ? t("profileRowCollapse") : t("profileRowExpand")}
        </Button>
      )}
    >
      {open ? (
        <div className="space-y-3" data-testid="native-config-body">
          <NativeConfigQuickToggles draft={draft} setDraft={setDraft} tool={tool} preview={preview} />
          <NativeOverrideEditor
            tool={tool}
            value={fragment}
            label={t("nativeConfig.profileFragment")}
            testId="native-config-profile-editor"
            onChange={(text) => setDraft((current) => ({
              ...current,
              nativeOverrides: withNativeOverride(current.nativeOverrides, tool, text),
            }))}
          />
          <div className="space-y-1.5" data-testid="native-config-preview">
            <div className="text-xs font-medium" style={{ color: "var(--app-text-secondary)" }}>
              {t("nativeConfig.previewTitle")}
              {preview?.providerName ? (
                <span className="ml-2 font-normal" style={{ color: "var(--app-text-tertiary)" }}>
                  {t("nativeConfig.previewContext", { provider: preview.providerName, model: preview.modelId ?? "—" })}
                </span>
              ) : null}
            </div>
            {error ? (
              <p className="text-[length:var(--text-caption)] text-[var(--app-status-danger)]">{t("nativeConfig.previewFailed", { error })}</p>
            ) : !preview ? (
              <p className="text-[length:var(--text-caption)]" style={{ color: "var(--app-text-tertiary)" }}>{t("nativeConfig.previewLoading")}</p>
            ) : preview.entries.length === 0 ? (
              <p className="text-[length:var(--text-caption)]" style={{ color: "var(--app-text-tertiary)" }}>{t("nativeConfig.previewEmpty")}</p>
            ) : (
              <ul className="divide-y divide-[var(--app-border)]/60 rounded-md border border-[var(--app-border)]">
                {preview.entries.map((entry) => (
                  <li key={entry.key} data-source={entry.source} className="flex min-w-0 items-center gap-2 px-2.5 py-1.5">
                    <code className="min-w-0 flex-1 truncate font-mono text-xs" style={{ color: "var(--app-text-primary)" }} title={`${entry.key} = ${entry.value}`}>
                      {entry.key}
                      <span style={{ color: "var(--app-text-tertiary)" }}> = </span>
                      <span style={{ color: "var(--app-text-secondary)" }}>{entry.value}</span>
                    </code>
                    <SourceBadge source={entry.source} />
                  </li>
                ))}
              </ul>
            )}
            {providerIssues.map((issue, index) => (
              <p key={`${issue.code}-${issue.key ?? index}`} className="text-[length:var(--text-caption)] text-[var(--app-status-warning)]">
                {t("nativeConfig.providerLayerIssue", { detail: issueText(issue) })}
              </p>
            ))}
            {notApplied.length > 0 && (
              <p data-testid="native-config-runtime-note" className="text-[length:var(--text-caption)] leading-5 text-[var(--app-status-warning)]">
                {t("nativeConfig.notAppliedOn", {
                  runtimes: notApplied.map((runtime) => RUNTIME_NAMES[runtime.runtime] ?? runtime.runtime).join(" / "),
                  reason: notApplied[0].note === "claudeSettingsLocalOnly" ? t("nativeConfig.runtimeNote.claudeSettingsLocalOnly") : "",
                })}
              </p>
            )}
          </div>
        </div>
      ) : null}
    </Section>
  );
}

function SourceBadge({ source }: { source: NativeConfigSource }) {
  const { t } = useTranslation("providers");
  return (
    <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[length:var(--text-micro)] font-normal">
      {t(`nativeConfig.source.${source}`)}
    </Badge>
  );
}
