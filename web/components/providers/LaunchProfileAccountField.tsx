// 运行配置基础卡里「供应商」旁的账号选择：只有一个可选账号时不渲染。
// 草稿里 null = 用供应商默认账号；选回默认账号也写 null。
import { useTranslation } from "react-i18next";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import AccountColorDot from "@/components/providers/accounts/AccountColorDot";
import { accountDisplayName, isLocalOnlyAccount } from "@/components/launcher/launcherAccounts";
import type { LaunchProfileDraft, Provider } from "@/types";
import { defaultAccountId, selectableAccounts } from "@/utils/providerAccounts";
import { Field } from "./launchProfileParts";
import { isRemoteProfileRuntime } from "./launchProfileAccounts";

interface LaunchProfileAccountFieldProps {
  draft: LaunchProfileDraft;
  setDraft: React.Dispatch<React.SetStateAction<LaunchProfileDraft>>;
  provider: Provider | undefined;
  cliTool: string;
}

export default function LaunchProfileAccountField({ draft, setDraft, provider, cliTool }: LaunchProfileAccountFieldProps) {
  const { t } = useTranslation("launcher");
  const accounts = selectableAccounts(provider, cliTool);
  if (!provider || accounts.length <= 1) return null;

  const fallbackId = defaultAccountId(provider) ?? accounts[0].id;
  const value = accounts.some((account) => account.id === draft.providerAccountId) ? draft.providerAccountId! : fallbackId;
  const remote = isRemoteProfileRuntime(draft.targetRuntime);
  const defaultLoginLabel = t("account.defaultLogin");
  const label = (account: (typeof accounts)[number]) => {
    const name = accountDisplayName(account, defaultLoginLabel);
    if (remote && isLocalOnlyAccount(account)) return t("account.loginLocalOnlyOption", { name });
    return account.isDefault ? t("account.defaultSuffix", { name }) : name;
  };

  return (
    <Field label={t("account.label")}>
      <Select
        value={value}
        onValueChange={(next) => setDraft((current) => ({
          ...current,
          providerAccountId: next === fallbackId ? null : next,
        }))}
      >
        <SelectTrigger aria-label={t("account.label")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {accounts.map((account) => (
            <SelectItem key={account.id} value={account.id} disabled={remote && isLocalOnlyAccount(account)}>
              <span className="flex items-center gap-1.5">
                <AccountColorDot color={account.color} />
                {label(account)}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {remote && accounts.some(isLocalOnlyAccount) && (
        <span className="block text-[length:var(--text-caption)] text-[var(--app-text-tertiary)]">{t("account.loginLocalOnly")}</span>
      )}
    </Field>
  );
}
