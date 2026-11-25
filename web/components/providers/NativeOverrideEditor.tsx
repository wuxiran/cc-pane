// 原生 CLI 配置片段编辑器（Codex TOML / Claude JSON）：等宽文本框 + 后端即时校验。
// 中转站编辑页与运行配置卡共用。校验只报键名与位置，不回显片段内容。
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { nativeConfigService } from "@/services/nativeConfigService";
import type { NativeConfigIssue, NativeOverrideTool, NativeOverrides, ProviderType } from "@/types";
import { isNativeOverrideTool } from "@/types/native-config";
import { nativeCliForProviderType } from "./launchProfileImport";

const VALIDATE_DELAY_MS = 300;

/** 片段的即时校验：输入停 300ms 后问后端（与保存时同一套规则）。Web 壳无后端时不报。 */
export function useNativeFragmentIssues(tool: NativeOverrideTool, text: string): NativeConfigIssue[] {
  const [issues, setIssues] = useState<NativeConfigIssue[]>([]);
  useEffect(() => {
    if (!text.trim()) {
      setIssues([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      nativeConfigService.validate(tool, text)
        .then((result) => { if (!cancelled) setIssues(result); })
        .catch(() => { if (!cancelled) setIssues([]); });
    }, VALIDATE_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [tool, text]);
  return issues;
}

/** 校验问题的用户文案：按代码出中英文，解析错误带后端给的位置说明。 */
export function useIssueText() {
  const { t } = useTranslation("providers");
  return (issue: NativeConfigIssue): string => {
    const key = issue.key ?? "";
    switch (issue.code) {
      case "forbiddenKey": return t("nativeConfig.issue.forbiddenKey", { key });
      case "secretKey": return t("nativeConfig.issue.secretKey", { key });
      case "notAnObject": return t("nativeConfig.issue.notAnObject");
      case "parseError": return t("nativeConfig.issue.parseError", { detail: issue.message });
      default: return issue.message;
    }
  };
}

/** 把一个 CLI 的片段写回映射：清空即删除该键（不留空串，免得「改了又删」被当成未保存修改）。 */
export function withNativeOverride(
  overrides: NativeOverrides | undefined,
  tool: NativeOverrideTool,
  text: string,
): NativeOverrides {
  const next = { ...(overrides ?? {}) };
  if (text === "") delete next[tool];
  else next[tool] = text;
  return next;
}

interface NativeOverrideEditorProps {
  tool: NativeOverrideTool;
  value: string;
  onChange: (value: string) => void;
  /** 读屏名称 */
  label: string;
  testId?: string;
}

export default function NativeOverrideEditor({ tool, value, onChange, label, testId }: NativeOverrideEditorProps) {
  const { t } = useTranslation("providers");
  const issues = useNativeFragmentIssues(tool, value);
  const issueText = useIssueText();
  return (
    <div className="space-y-2">
      <Textarea
        data-testid={testId}
        aria-label={label}
        aria-invalid={issues.length > 0}
        spellCheck={false}
        rows={6}
        className="min-h-28 font-mono text-xs leading-5"
        value={value}
        placeholder={t(`nativeConfig.placeholder.${tool}`)}
        onChange={(event) => onChange(event.target.value)}
      />
      <p className="text-[length:var(--text-caption)] leading-5" style={{ color: "var(--app-text-tertiary)" }}>
        {t(`nativeConfig.formatHint.${tool}`)}
      </p>
      {issues.length > 0 && (
        <ul data-testid={testId ? `${testId}-issues` : undefined} className="space-y-0.5 text-[length:var(--text-caption)] leading-5 text-[var(--app-status-danger)]">
          {issues.map((issue, index) => (
            <li key={`${issue.code}-${issue.key ?? index}`}>{issueText(issue)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 中转站编辑页的「原生配置覆盖」段：按供应商类型的原生 CLI 选格式；不支持的 CLI 不出这一段。 */
export function ProviderNativeOverrideSection({ providerType, value, onChange }: {
  providerType: ProviderType;
  value: NativeOverrides;
  onChange: (next: NativeOverrides) => void;
}) {
  const { t } = useTranslation("providers");
  const tool = nativeCliForProviderType(providerType);
  if (!isNativeOverrideTool(tool)) return null;
  return (
    <div className="flex flex-col gap-1.5" data-testid="provider-native-overrides">
      <Label className="text-xs font-medium">{t("nativeConfig.providerTitle")}</Label>
      <p className="text-[length:var(--text-caption)] leading-5" style={{ color: "var(--app-text-tertiary)" }}>
        {t("nativeConfig.providerHint")}
      </p>
      <NativeOverrideEditor
        tool={tool}
        value={value[tool] ?? ""}
        label={t("nativeConfig.providerTitle")}
        testId="provider-native-override-editor"
        onChange={(text) => onChange(withNativeOverride(value, tool, text))}
      />
    </div>
  );
}
