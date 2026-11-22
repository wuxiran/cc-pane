// 标签上的账号小标记：会话用的不是供应商默认账号时，画一个账号颜色的小点（悬浮显示账号名）。
// 数据只来自 tab 上已有的 providerId + providerAccountId（terminalLeafActions 从启动历史成对写回）
// 和 useProvidersStore 里已加载的供应商列表；不轮询、不额外请求。供应商没加载 / 找不到时不画。
import { useTranslation } from "react-i18next";
import AccountColorDot from "@/components/providers/accounts/AccountColorDot";
import { useProvidersStore } from "@/stores";
import { isDefaultLoginAccount } from "@/types/provider";
import { defaultAccountId, findProviderAccount } from "@/utils/providerAccounts";
import { accountDisplayName } from "@/components/launcher/launcherAccounts";

interface TabAccountMarkProps {
  providerId?: string;
  providerAccountId?: string;
}

export default function TabAccountMark({ providerId, providerAccountId }: TabAccountMarkProps) {
  const { t } = useTranslation(["panes", "launcher"]);
  const provider = useProvidersStore((s) =>
    providerId && providerAccountId ? s.providers.find((item) => item.id === providerId) : undefined);
  if (!provider || !providerAccountId) return null;
  if (providerAccountId === defaultAccountId(provider)) return null;

  const account = findProviderAccount(provider, providerAccountId);
  // 默认登录不落盘、没有颜色；其它找不到记录的账号（已删）不画，免得标一个不存在的号
  if (!account && !isDefaultLoginAccount(providerAccountId)) return null;
  const name = accountDisplayName(account ?? { id: providerAccountId }, t("launcher:account.defaultLogin"));
  return (
    <AccountColorDot
      size="xs"
      color={account?.color}
      title={t("panes:tabAccountMark", { name })}
    />
  );
}
