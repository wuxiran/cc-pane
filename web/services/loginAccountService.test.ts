import { beforeEach, describe, expect, it } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { loginAccountService } from "./loginAccountService";
import { mockTauriInvoke, resetTauriInvoke } from "@/test/utils/mockTauriInvoke";
import {
  DEFAULT_LOGIN_ACCOUNT_ID,
  isDefaultLoginAccount,
  type LoginAccountView,
  type LoginCommand,
} from "@/types/provider";

const account: LoginAccountView = {
  providerId: "p-1",
  accountId: "claude-0123456789ab",
  name: "个人号",
  color: "#3b82f6",
  cliTool: "claude",
  isDefaultLogin: false,
  configDir: "/data/login-accounts/claude-0123456789ab",
  dirManaged: true,
  dirExists: true,
  status: { state: "not_logged_in" },
};

describe("loginAccountService", () => {
  beforeEach(() => {
    resetTauriInvoke();
  });

  it("listLoginAccounts 返回默认登录和用户建的登录账号", async () => {
    const defaultLogin: LoginAccountView = {
      ...account,
      accountId: DEFAULT_LOGIN_ACCOUNT_ID,
      name: "默认登录",
      isDefaultLogin: true,
      configDir: undefined,
      dirManaged: false,
      dirExists: false,
      status: { state: "logged_in", identity: "me@example.com", credentialSource: "keychain" },
    };
    mockTauriInvoke({ list_login_accounts: [defaultLogin, account] });

    const result = await loginAccountService.listLoginAccounts("p-1");

    expect(invoke).toHaveBeenCalledWith("list_login_accounts", { providerId: "p-1" });
    expect(result.map((item) => isDefaultLoginAccount(item.accountId))).toEqual([true, false]);
  });

  it("createLoginAccount 只交 CLI、名字和颜色，目录由后端决定", async () => {
    mockTauriInvoke({ create_login_account: account });

    const result = await loginAccountService.createLoginAccount("p-1", {
      cliTool: "claude",
      name: "个人号",
      color: "#3b82f6",
    });

    expect(invoke).toHaveBeenCalledWith("create_login_account", {
      providerId: "p-1",
      request: { cliTool: "claude", name: "个人号", color: "#3b82f6" },
    });
    expect(result.configDir).toBe(account.configDir);
  });

  it("getLoginStatus 查默认登录时带上 CLI", async () => {
    mockTauriInvoke({ get_login_account_status: { state: "unknown", reason: "keychain_unavailable" } });

    const status = await loginAccountService.getLoginStatus("p-1", DEFAULT_LOGIN_ACCOUNT_ID, "codex");

    expect(invoke).toHaveBeenCalledWith("get_login_account_status", {
      providerId: "p-1",
      accountId: DEFAULT_LOGIN_ACCOUNT_ID,
      cliTool: "codex",
    });
    expect(status.state).toBe("unknown");
  });

  it("getLoginCommand 返回要在终端里执行的命令和环境变量", async () => {
    const command: LoginCommand = {
      cliTool: "claude",
      command: "/usr/local/bin/claude",
      args: ["auth", "login"],
      env: { CLAUDE_CONFIG_DIR: "/data/login-accounts/claude-0123456789ab" },
      envRemove: ["ANTHROPIC_API_KEY"],
      interactive: false,
      executableFound: true,
    };
    mockTauriInvoke({ get_login_account_command: command });

    const result = await loginAccountService.getLoginCommand("p-1", account.accountId);

    expect(invoke).toHaveBeenCalledWith("get_login_account_command", {
      providerId: "p-1",
      accountId: account.accountId,
      cliTool: null,
    });
    expect(result).toEqual(command);
  });

  it("deleteAccount 默认保留目录，要求时才连目录一起删", async () => {
    mockTauriInvoke({
      delete_provider_account: { accountId: account.accountId, dirDeleted: false },
    });

    await loginAccountService.deleteAccount("p-1", account.accountId);
    expect(invoke).toHaveBeenLastCalledWith("delete_provider_account", {
      providerId: "p-1",
      accountId: account.accountId,
      deleteDir: false,
    });

    await loginAccountService.deleteAccount("p-1", account.accountId, true);
    expect(invoke).toHaveBeenLastCalledWith("delete_provider_account", {
      providerId: "p-1",
      accountId: account.accountId,
      deleteDir: true,
    });
  });
});
