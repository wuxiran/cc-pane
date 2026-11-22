import "@/i18n";
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLaunchProfilesStore, useProvidersStore } from "@/stores";
import type { OpenTerminalOptions, Provider } from "@/types";
import { DEFAULT_LOGIN_ACCOUNT_ID } from "@/types/provider";
import LauncherProviderRow from "./LauncherProviderRow";
import { buildPendingLaunch, createDefaultDraft, type LauncherDraft } from "./launcherModel";
import { effectiveLaunchAccountId, profileAccountIdForSave } from "./launcherAccounts";

vi.mock("@/hooks/useCliTools", () => ({ useCliTools: () => ({ tools: [] }) }));

export const multiAccountProvider: Provider = {
  id: "p-multi",
  name: "Anthropic Relay",
  providerType: "anthropic",
  isDefault: false,
  defaultAccountId: "acc-work",
  accounts: [
    { id: "acc-work", name: "工作号", kind: "api_key", color: "blue" },
    { id: "acc-personal", name: "个人号", kind: "api_key", color: "green" },
    { id: "acc-login", name: "登录号", kind: "login", cliTool: "claude", configDir: "/accounts/login", color: "purple" },
  ],
};

export const singleAccountProvider: Provider = {
  id: "p-single",
  name: "Single Key",
  providerType: "anthropic",
  isDefault: false,
  accounts: [{ id: "acc-only", name: "默认", kind: "api_key" }],
};

const deps = { workspaces: [], machines: [], providers: [multiAccountProvider, singleAccountProvider] };

function explicitDraft(partial: Partial<LauncherDraft>): LauncherDraft {
  return createDefaultDraft({
    source: { kind: "manual", path: "/repo" },
    cliTool: "claude",
    providerSelection: "explicit",
    ...partial,
  });
}

function recentDraft(options: Partial<OpenTerminalOptions>, cliTool: LauncherDraft["cliTool"] = "claude"): LauncherDraft {
  return createDefaultDraft({
    cliTool,
    source: { kind: "recent", label: "repo", options: { path: "/repo", ...options } },
  });
}

describe("launcher account rules", () => {
  it("只有一个账号时运行配置保存显式带 null，多账号时带选中的非默认账号", () => {
    expect(profileAccountIdForSave(singleAccountProvider, "claude", "acc-only")).toBeNull();
    expect(profileAccountIdForSave(multiAccountProvider, "claude", "acc-personal")).toBe("acc-personal");
    expect(profileAccountIdForSave(multiAccountProvider, "claude", "acc-work")).toBeNull();
    expect(profileAccountIdForSave(multiAccountProvider, "claude", "acc-deleted")).toBeNull();
  });

  it("远端运行时本机登录账号失效，默认登录和密钥账号照常可用", () => {
    expect(effectiveLaunchAccountId(multiAccountProvider, "claude", "acc-login", true)).toBeUndefined();
    expect(effectiveLaunchAccountId(multiAccountProvider, "claude", DEFAULT_LOGIN_ACCOUNT_ID, true)).toBe(DEFAULT_LOGIN_ACCOUNT_ID);
    expect(effectiveLaunchAccountId(multiAccountProvider, "claude", "acc-personal", true)).toBe("acc-personal");
  });
});

describe("buildPendingLaunch · providerAccountId", () => {
  it("显式供应商下选中的账号带进启动请求", () => {
    const { launch } = buildPendingLaunch(explicitDraft({ providerId: "p-multi", providerAccountId: "acc-personal" }), deps);
    expect(launch?.providerId).toBe("p-multi");
    expect(launch?.providerAccountId).toBe("acc-personal");
  });

  it("没选账号时不带字段（= 供应商默认账号）", () => {
    const { launch } = buildPendingLaunch(explicitDraft({ providerId: "p-multi" }), deps);
    expect(launch).not.toBeNull();
    expect(launch && "providerAccountId" in launch).toBe(false);
  });

  it("「最近启动」记住的账号随来源恢复", () => {
    const { launch } = buildPendingLaunch(recentDraft({ providerId: "p-multi", providerAccountId: "acc-login" }), deps);
    expect(launch?.providerId).toBe("p-multi");
    expect(launch?.providerAccountId).toBe("acc-login");
  });

  it("记住的账号被删了就退回默认账号", () => {
    const { launch } = buildPendingLaunch(recentDraft({ providerId: "p-multi", providerAccountId: "acc-gone" }), deps);
    expect(launch?.providerId).toBe("p-multi");
    expect(launch?.providerAccountId).toBeUndefined();
  });

  it("换了 CLI 后登录账号不可选，退回默认账号", () => {
    const { launch } = buildPendingLaunch(recentDraft({ providerId: "p-multi", providerAccountId: "acc-login" }, "pi"), deps);
    expect(launch?.providerAccountId).toBeUndefined();
  });

  it("记住的账号所属供应商已删除时也退回默认", () => {
    const { launch } = buildPendingLaunch(recentDraft({ providerId: "p-removed", providerAccountId: "acc-x" }), deps);
    expect(launch?.providerAccountId).toBeUndefined();
  });

  it("运行时是 WSL 时本机登录账号不带", () => {
    const draft = recentDraft({ providerId: "p-multi", providerAccountId: "acc-login", wsl: { distro: "Ubuntu", remotePath: "/home/u/repo" } });
    expect(buildPendingLaunch(draft, deps).launch?.providerAccountId).toBeUndefined();
  });

  it("不接供应商（none）时不带账号", () => {
    const draft = explicitDraft({ providerSelection: "none", providerId: "p-multi", providerAccountId: "acc-personal" });
    expect(buildPendingLaunch(draft, deps).launch?.providerAccountId).toBeUndefined();
  });
});

function ControlledRow({ initial, remote, onDraft }: { initial: LauncherDraft; remote?: boolean; onDraft: (draft: LauncherDraft) => void }) {
  const [draft, setDraft] = useState(initial);
  return (
    <LauncherProviderRow
      draft={draft}
      remote={remote}
      onChange={(patch) => setDraft((current) => {
        const next = { ...current, ...patch };
        onDraft(next);
        return next;
      })}
    />
  );
}

describe("LauncherProviderRow · 账号选择", () => {
  beforeEach(() => {
    useProvidersStore.setState({ providers: [multiAccountProvider, singleAccountProvider] });
    useLaunchProfilesStore.setState({ profiles: [], load: vi.fn().mockResolvedValue(undefined) });
  });

  it("单账号供应商不出现账号选择", () => {
    render(<ControlledRow initial={explicitDraft({ providerId: "p-single" })} onDraft={vi.fn()} />);
    expect(screen.queryByRole("combobox", { name: "账号" })).toBeNull();
  });

  it("多账号时出现账号选择，选中后启动请求里带 providerAccountId", async () => {
    let latest = explicitDraft({ providerId: "p-multi" });
    render(<ControlledRow initial={latest} onDraft={(draft) => { latest = draft; }} />);
    const select = screen.getByRole("combobox", { name: "账号" });
    expect(select).toHaveValue("acc-work");
    expect(screen.getByRole("option", { name: "工作号（默认）" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "默认登录" })).toBeInTheDocument();
    await userEvent.selectOptions(select, "acc-personal");
    expect(latest.providerAccountId).toBe("acc-personal");
    expect(buildPendingLaunch(latest, deps).launch?.providerAccountId).toBe("acc-personal");

    // 选回默认账号 = 不点名
    await userEvent.selectOptions(select, "acc-work");
    expect(latest.providerAccountId).toBeUndefined();
  });

  it("换供应商时清掉账号选择", async () => {
    let latest = explicitDraft({ providerId: "p-multi", providerAccountId: "acc-personal" });
    render(<ControlledRow initial={latest} onDraft={(draft) => { latest = draft; }} />);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Provider" }), "p-single");
    expect(latest.providerId).toBe("p-single");
    expect(latest.providerAccountId).toBeUndefined();
    expect(screen.queryByRole("combobox", { name: "账号" })).toBeNull();
  });

  it("远端运行时本机登录账号禁用并给出说明；已选的登录账号退回默认", () => {
    let latest = explicitDraft({ providerId: "p-multi", providerAccountId: "acc-login" });
    render(<ControlledRow initial={latest} remote onDraft={(draft) => { latest = draft; }} />);
    expect(screen.getByRole("option", { name: "登录号（仅本机）" })).toBeDisabled();
    expect(screen.getByText(/登录账号只能在本机运行时使用/)).toBeInTheDocument();
    expect(latest.providerAccountId).toBeUndefined();
  });
});
