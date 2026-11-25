import "@/i18n";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { resetLoginStatusCacheForTests } from "@/hooks/useLoginStatuses";
import { loginAccountService } from "@/services/loginAccountService";
import type { LaunchProfileDraft, Provider } from "@/types";
import { DEFAULT_LOGIN_ACCOUNT_ID, SYSTEM_PROVIDER_ID } from "@/types/provider";
import LaunchProfileCredentialField from "./LaunchProfileCredentialField";

vi.mock("@/services/loginAccountService", () => ({
  loginAccountService: { getLoginStatus: vi.fn() },
}));

const tp = (key: string, params?: Record<string, string>) => String(i18n.t(`providers:${key}` as never, params as never));

const loginProvider: Provider = {
  id: "p-login",
  name: "Anthropic Login",
  providerType: "anthropic",
  isDefault: false,
  defaultAccountId: "acc-login",
  accounts: [{ id: "acc-login", name: "登录号", kind: "login", cliTool: "claude" }],
};

function renderField(draft: Partial<LaunchProfileDraft>) {
  return render(
    <LaunchProfileCredentialField
      draft={draft as LaunchProfileDraft}
      setDraft={vi.fn()}
      providers={[loginProvider]}
      activeTool="claude"
    />,
  );
}

describe("LaunchProfileCredentialField login status", () => {
  beforeEach(() => {
    resetLoginStatusCacheForTests();
    vi.mocked(loginAccountService.getLoginStatus).mockReset();
  });

  it("shows the CLI's own login with plan and a masked email, fetched once", async () => {
    vi.mocked(loginAccountService.getLoginStatus).mockResolvedValue({
      state: "logged_in",
      identity: "wuxiran@example.com",
      plan: "Claude Team",
    });
    const { rerender } = renderField({ providerId: null });
    const line = await screen.findByTestId("credential-login-status");
    expect(line).toHaveTextContent(`${tp("providerAccounts.login.state.authenticatedPlan", { plan: "Claude Team" })} · wu***@example.com`);
    expect(line).not.toHaveTextContent("wuxiran@");
    expect(loginAccountService.getLoginStatus).toHaveBeenCalledWith(SYSTEM_PROVIDER_ID, DEFAULT_LOGIN_ACCOUNT_ID, "claude");

    rerender(
      <LaunchProfileCredentialField
        draft={{ providerId: null } as LaunchProfileDraft}
        setDraft={vi.fn()}
        providers={[loginProvider]}
        activeTool="claude"
      />,
    );
    expect(loginAccountService.getLoginStatus).toHaveBeenCalledTimes(1);
  });

  it("tells the user how to log in when the CLI is not logged in", async () => {
    vi.mocked(loginAccountService.getLoginStatus).mockResolvedValue({ state: "not_logged_in" });
    renderField({ providerId: null });
    const line = await screen.findByTestId("credential-login-status");
    expect(line).toHaveTextContent(tp("providerAccounts.login.state.notLoggedInRun", { command: "claude" }));
  });

  it("shows the selected OAuth account's state under the field", async () => {
    vi.mocked(loginAccountService.getLoginStatus).mockResolvedValue({ state: "logged_in", plan: "Claude Max" });
    renderField({ providerId: "p-login", providerAccountId: "acc-login" });
    await waitFor(() =>
      expect(screen.getByTestId("credential-login-status")).toHaveTextContent(
        tp("providerAccounts.login.state.authenticatedPlan", { plan: "Claude Max" }),
      ),
    );
    expect(loginAccountService.getLoginStatus).toHaveBeenCalledWith("p-login", "acc-login", "claude");
  });
});
