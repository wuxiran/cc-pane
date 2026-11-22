// 运行配置摘要卡的账号文案：草稿选的供应商在当前 CLI 下有多个账号时，显示用的是哪个（没点名 = 默认账号）。
import { useTranslation } from "react-i18next";
import { useProvidersStore } from "@/stores";
import type { LaunchProfileDraft } from "@/types";
import { selectableAccounts } from "@/utils/providerAccounts";
import { accountDisplayName } from "@/components/launcher/launcherAccounts";

export function useLaunchProfileAccountLabel(
  draft: LaunchProfileDraft,
  cliTool: string,
  systemDefault: boolean,
): string | undefined {
  const { t } = useTranslation("launcher");
  const providers = useProvidersStore((s) => s.providers);
  if (systemDefault || !draft.providerId) return undefined;
  const provider = providers.find((item) => item.id === draft.providerId);
  const accounts = selectableAccounts(provider, cliTool);
  if (accounts.length <= 1) return undefined;
  const account = accounts.find((item) => item.id === draft.providerAccountId)
    ?? accounts.find((item) => item.isDefault);
  if (!account) return undefined;
  const name = accountDisplayName(account, t("account.defaultLogin"));
  return t("account.summary", { name: account.isDefault ? t("account.defaultSuffix", { name }) : name });
}
