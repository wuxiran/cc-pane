import type {
  CreateLoginAccountRequest,
  DeleteAccountOutcome,
  LoginAccountCliTool,
  LoginAccountStatus,
  LoginAccountView,
  LoginCommand,
} from "@/types/provider";
import { apiDeleteJson, apiGet, apiJson, invokeOrApi } from "./apiClient";

function accountPath(providerId: string, accountId: string): string {
  return `/api/providers/${encodeURIComponent(providerId)}/accounts/${encodeURIComponent(accountId)}`;
}

function cliQuery(cliTool?: LoginAccountCliTool | null): string {
  return cliTool ? `?cliTool=${encodeURIComponent(cliTool)}` : "";
}

/**
 * 五个 CLI（Claude / Codex / Gemini / Antigravity / Grok）的登录账号。
 * 一个登录账号 = CC-Panes 建的一个独立目录；机器上原有的登录是合成的「默认登录」。
 */
export const loginAccountService = {
  /** 这条供应商下的登录账号：每个 CLI 一个默认登录，加上用户建的；每条带登录状态。 */
  async listLoginAccounts(providerId: string): Promise<LoginAccountView[]> {
    return invokeOrApi<LoginAccountView[]>("list_login_accounts", { providerId }, () =>
      apiGet<LoginAccountView[]>(`/api/providers/${encodeURIComponent(providerId)}/login-accounts`),
    );
  },

  /** 新建登录账号：后端自己建目录并链接共享文件，用户只给名字和颜色。 */
  async createLoginAccount(
    providerId: string,
    request: CreateLoginAccountRequest,
  ): Promise<LoginAccountView> {
    return invokeOrApi<LoginAccountView>("create_login_account", { providerId, request }, () =>
      apiJson<LoginAccountView>(
        `/api/providers/${encodeURIComponent(providerId)}/login-accounts`,
        "POST",
        request,
      ),
    );
  },

  /** 是否已登录、是哪个号。`cliTool` 只在查默认登录时需要。 */
  async getLoginStatus(
    providerId: string,
    accountId: string,
    cliTool?: LoginAccountCliTool | null,
  ): Promise<LoginAccountStatus> {
    return invokeOrApi<LoginAccountStatus>(
      "get_login_account_status",
      { providerId, accountId, cliTool: cliTool ?? null },
      () => apiGet<LoginAccountStatus>(`${accountPath(providerId, accountId)}/login-status${cliQuery(cliTool)}`),
    );
  },

  /** 登录命令：拿去开一个终端标签执行。 */
  async getLoginCommand(
    providerId: string,
    accountId: string,
    cliTool?: LoginAccountCliTool | null,
  ): Promise<LoginCommand> {
    return invokeOrApi<LoginCommand>(
      "get_login_account_command",
      { providerId, accountId, cliTool: cliTool ?? null },
      () => apiGet<LoginCommand>(`${accountPath(providerId, accountId)}/login-command${cliQuery(cliTool)}`),
    );
  },

  /** 删除账号。`deleteDir` 为真时同时删登录目录（后端只删 CC-Panes 自己建的目录）。 */
  async deleteAccount(
    providerId: string,
    accountId: string,
    deleteDir = false,
  ): Promise<DeleteAccountOutcome> {
    return invokeOrApi<DeleteAccountOutcome>(
      "delete_provider_account",
      { providerId, accountId, deleteDir },
      () =>
        apiDeleteJson<DeleteAccountOutcome>(
          `${accountPath(providerId, accountId)}${deleteDir ? "?deleteDir=true" : ""}`,
        ),
    );
  },
};
