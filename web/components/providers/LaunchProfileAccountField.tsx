// 运行配置基础卡里「供应商」旁的账号选择：只有一个可选账号时不渲染。
// 草稿里 null = 用供应商默认账号；选回默认账号也写 null。
// 运行配置本机 / WSL / SSH 通用：本机登录账号照常可选，只提示远端启动时会退回供应商默认账号。
import { useTranslation } from "react-i18next";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import AccountColorDot from "@/components/providers/accounts/AccountColorDot";
import { accountDisplayName, isLocalOnlyAccount } from "@/components/launcher/launcherAccounts";
import type { LaunchProfileDraft, Provider } from "@/types";
import { defaultAccountId, selectableAccounts } from "@/utils/providerAccounts";
import { Field } from "./launchProfileParts";

interface LaunchProfileAccountFieldProps {
  draft: LaunchProfileDraft;
  setDraft: React.Dispatch<React.SetStateAction<LaunchProfileDraft>>;
  provider: Provider | undefined;
  cliTool: string;
}

export default function LaunchProfileAccountField({ draft, setDraft, provider, cliTool }: LaunchProfileAccountFieldProps) {
  const { t } = useTranslation(["launcher", "providers"]);
  const accounts = selectableAccounts(provider, cliTool);
  if (!provider || accounts.length <= 1) return null;

  const fallbackId = defaultAccountId(provider) ?? accounts[0].id;
  const value = accounts.some((account) => account.id === draft.providerAccountId) ? draft.providerAccountId! : fallbackId;
  const defaultLoginLabel = t("account.defaultLogin");
  const selectedLocalOnly = accounts.some((account) => account.id === value && isLocalOnlyAccount(account));
  const label = (account: (typeof accounts)[number]) => {
    const name = accountDisplayName(account, defaultLoginLabel);
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
            <SelectItem key={account.id} value={account.id}>
              <span className="flex items-center gap-1.5">
                <AccountColorDot color={account.color} />
                {label(account)}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {selectedLocalOnly && (
        <span
          data-testid="profile-account-local-only-hint"
          className="block text-[length:var(--text-caption)] text-[var(--app-text-tertiary)]"
        >
          {t("providers:accountLocalOnlyFallback")}
        </span>
      )}
    </Field>
  );
}
