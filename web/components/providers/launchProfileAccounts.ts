// 运行配置保存时的供应商 / 账号 / 模型三件套（纯逻辑）。
// 账号字段必须显式写出：保存请求不带 providerAccountId 会被后端清空；null = 用供应商默认账号。
// 运行配置不区分运行位置（本机 / WSL / SSH 通用）：用户选的账号原样保存，即使是只在本机可用的
// 登录账号——在 WSL / SSH 启动时由后端（及启动器）自动退回供应商默认账号。
import type { LaunchProfileDraft, Provider } from "@/types";
import { effectiveLaunchAccountId, profileAccountIdForSave } from "@/components/launcher/launcherAccounts";

type ProviderFields = Pick<LaunchProfileDraft, "providerId" | "providerAccountId" | "modelId">;

export function profileProviderFields(
  draft: LaunchProfileDraft,
  systemDefault: boolean,
  provider: Provider | undefined,
  cliTool: string,
): ProviderFields {
  if (systemDefault) return { providerId: null, providerAccountId: null, modelId: null };
  if (!draft.providerId) return { providerId: draft.providerId, providerAccountId: null, modelId: null };
  // 供应商列表里找不到这家（未加载 / 已删）：判断不了账号，原样保留，交给后端解析。
  if (!provider) return { providerId: draft.providerId, providerAccountId: draft.providerAccountId ?? null, modelId: draft.modelId };
  const accountId = profileAccountIdForSave(provider, cliTool, draft.providerAccountId);
  return {
    providerId: draft.providerId,
    providerAccountId: effectiveLaunchAccountId(provider, cliTool, accountId) ?? null,
    modelId: draft.modelId,
  };
}
