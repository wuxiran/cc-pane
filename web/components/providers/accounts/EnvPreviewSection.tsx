import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { IconTooltipButton } from "@/components/ui/IconTooltipButton";
import { useCliTools } from "@/hooks/useCliTools";
import { providerService } from "@/services/providerService";
import { translateError } from "@/utils";
import { compatibleCliToolsForProviderType } from "@/utils/providerCompatibility";
import { loginCliToolsForProviderType } from "@/utils/providerAccounts";
import {
  CLI_TOOL_TABS,
  DEFAULT_LOGIN_ACCOUNT_ID,
  type ProviderEnvPreviewEntry,
  type ProviderType,
} from "@/types/provider";
import type { KnownCliTool } from "@/types/terminal";
import type { AccountDraft } from "./drafts";

interface EnvPreviewSectionProps {
  providerId: string;
  providerType: ProviderType;
  /** 已保存的账号（预览按后端已存的配置算）。 */
  accounts: AccountDraft[];
  defaultAccountId: string | null;
  activeTab?: KnownCliTool;
  /** 表单有未保存修改：提示预览不含这些修改。 */
  dirty: boolean;
}

const CLI_LABEL_KEYS = new Map<string, string>(CLI_TOOL_TABS.map((tab) => [tab.id, tab.labelKey]));

/** 「启动时实际注入（预览）」：选账号与 CLI，显示后端算出的环境变量；敏感值后端已打码，这里原样显示。 */
export default function EnvPreviewSection({
  providerId,
  providerType,
  accounts,
  defaultAccountId,
  activeTab,
  dirty,
}: EnvPreviewSectionProps) {
  const { t } = useTranslation(["providers", "settings"]);
  const { tools } = useCliTools();
  const savedAccounts = accounts.filter((account) => !account.isNew);
  const cliOptions = useMemo(() => {
    const compatible = compatibleCliToolsForProviderType(providerType, tools, CLI_TOOL_TABS.map((tab) => tab.id));
    const login = loginCliToolsForProviderType(providerType).filter((tool) => !compatible.includes(tool as KnownCliTool));
    return [...compatible, ...login] as string[];
  }, [providerType, tools]);
  const [accountId, setAccountId] = useState<string>(defaultAccountId ?? savedAccounts[0]?.id ?? "");
  const [cliTool, setCliTool] = useState<string>(() => (
    activeTab && cliOptions.includes(activeTab) ? activeTab : cliOptions[0] ?? "claude"
  ));
  const [entries, setEntries] = useState<ProviderEnvPreviewEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  // 选中的账号被删掉了：退回默认账号。
  const accountKnown = accountId === DEFAULT_LOGIN_ACCOUNT_ID || savedAccounts.some((account) => account.id === accountId);
  if (!accountKnown && savedAccounts.length > 0) {
    const fallback = savedAccounts.find((account) => account.id === defaultAccountId) ?? savedAccounts[0];
    setAccountId(fallback.id);
  }
  const selectedAccount = savedAccounts.find((account) => account.id === accountId);
  // 登录账号只在它自己的 CLI 下有意义。
  const effectiveCli = selectedAccount?.kind === "login" && selectedAccount.cliTool ? selectedAccount.cliTool : cliTool;

  useEffect(() => {
    let cancelled = false;
    setError(null);
    providerService.previewProviderEnv(providerId, accountId || null, effectiveCli)
      .then((result) => { if (!cancelled) setEntries(result); })
      .catch((err) => {
        if (cancelled) return;
        setEntries(null);
        setError(translateError(err));
      });
    return () => { cancelled = true; };
  }, [providerId, accountId, effectiveCli, nonce]);

  const cliLabel = (tool: string) => {
    const key = CLI_LABEL_KEYS.get(tool);
    return key ? t(`settings:${key}` as "settings:tabClaude") : tool;
  };

  return (
    <section className="pt-1" aria-labelledby="provider-env-preview-title">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 id="provider-env-preview-title" className="text-[length:var(--text-row)] font-semibold" style={{ color: "var(--app-text-primary)" }}>
          {t("providers:providerAccounts.section.preview")}
        </h3>
        <IconTooltipButton label={t("providers:providerAccounts.preview.refresh")} className="h-7 w-7" onClick={() => setNonce((n) => n + 1)}>
          <RefreshCw size={13} />
        </IconTooltipButton>
      </div>
      <div className="mb-2 flex flex-wrap gap-2">
        {savedAccounts.length > 0 && (
        <Select value={accountId} onValueChange={setAccountId}>
          <SelectTrigger aria-label={t("providers:providerAccounts.preview.account")} className="h-8 min-w-40 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {savedAccounts.map((account) => (
              <SelectItem key={account.id} value={account.id}>{account.name}</SelectItem>
            ))}
            {savedAccounts.some((account) => account.kind === "login") && (
              <SelectItem value={DEFAULT_LOGIN_ACCOUNT_ID}>{t("providers:providerAccounts.account.defaultLogin")}</SelectItem>
            )}
          </SelectContent>
        </Select>
        )}
        <Select value={effectiveCli} onValueChange={setCliTool} disabled={selectedAccount?.kind === "login"}>
          <SelectTrigger aria-label={t("providers:providerAccounts.preview.cli")} className="h-8 min-w-32 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(cliOptions.includes(effectiveCli) ? cliOptions : [...cliOptions, effectiveCli]).map((tool) => (
              <SelectItem key={tool} value={tool}>{cliLabel(tool)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {dirty && (
        <p className="mb-2 text-[length:var(--text-caption)]" style={{ color: "var(--app-status-warning)" }}>
          {t("providers:providerAccounts.preview.unsavedHint")}
        </p>
      )}
      <div
        data-testid="provider-env-preview"
        className="rounded-md border px-3 py-2 font-mono text-[length:var(--text-caption)]"
        style={{ borderColor: "var(--app-border)", background: "var(--app-panel-bg)", color: "var(--app-text-primary)" }}
      >
        {error ? (
          <span style={{ color: "var(--app-status-error, var(--app-status-warning))" }}>
            {t("providers:providerAccounts.preview.failed", { error })}
          </span>
        ) : entries === null ? (
          <span style={{ color: "var(--app-text-tertiary)" }}>{t("providers:providerAccounts.preview.loading")}</span>
        ) : entries.length === 0 ? (
          <span style={{ color: "var(--app-text-tertiary)" }}>{t("providers:providerAccounts.preview.empty")}</span>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {entries.map((entry) => (
              <li key={entry.name} className="flex flex-wrap items-center gap-1.5 break-all">
                <span>{entry.name}={entry.value}</span>
                {entry.layer !== "generated" && (
                  <Badge variant="outline" className="px-1 py-0 font-sans text-[length:var(--text-nano)]">
                    {t(`providers:providerAccounts.preview.layer.${entry.layer}`)}
                  </Badge>
                )}
                {entry.overridesGenerated && (
                  <Badge variant="secondary" className="px-1 py-0 font-sans text-[length:var(--text-nano)]">
                    {t("providers:providerAccounts.preview.overrides")}
                  </Badge>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="mt-1 text-[length:var(--text-caption)]" style={{ color: "var(--app-text-tertiary)" }}>
        {t("providers:providerAccounts.preview.maskedHint")}
      </p>
    </section>
  );
}
