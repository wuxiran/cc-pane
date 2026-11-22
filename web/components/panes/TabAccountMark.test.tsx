import "@/i18n";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useProvidersStore } from "@/stores";
import type { Provider } from "@/types";
import { DEFAULT_LOGIN_ACCOUNT_ID } from "@/types/provider";
import TabAccountMark from "./TabAccountMark";

const provider: Provider = {
  id: "p-multi",
  name: "Anthropic Relay",
  providerType: "anthropic",
  isDefault: false,
  defaultAccountId: "acc-work",
  accounts: [
    { id: "acc-work", name: "工作号", kind: "api_key", color: "blue" },
    { id: "acc-personal", name: "个人号", kind: "api_key", color: "green" },
    { id: "acc-login", name: "登录号", kind: "login", cliTool: "claude", configDir: "/a" },
  ],
};

describe("TabAccountMark", () => {
  beforeEach(() => {
    useProvidersStore.setState({ providers: [provider] });
  });

  it("非默认账号显示账号颜色的小点，悬浮显示账号名", () => {
    render(<TabAccountMark providerId="p-multi" providerAccountId="acc-personal" />);
    const dot = screen.getByTestId("account-color-dot");
    expect(dot).toHaveAttribute("title", "账号：个人号");
    expect(dot).toHaveAttribute("data-color", "green");
    expect(dot.style.backgroundColor).toBe("var(--app-tag-green)");
  });

  it("默认账号不显示", () => {
    render(<TabAccountMark providerId="p-multi" providerAccountId="acc-work" />);
    expect(screen.queryByTestId("account-color-dot")).toBeNull();
  });

  it("默认登录也算非默认账号：次要色 + 「默认登录」", () => {
    render(<TabAccountMark providerId="p-multi" providerAccountId={DEFAULT_LOGIN_ACCOUNT_ID} />);
    const dot = screen.getByTestId("account-color-dot");
    expect(dot).toHaveAttribute("title", "账号：默认登录");
    expect(dot.style.backgroundColor).toBe("var(--app-text-tertiary)");
  });

  it("没有账号 / 供应商没加载 / 账号已删时不显示", () => {
    const { rerender } = render(<TabAccountMark providerId="p-multi" />);
    expect(screen.queryByTestId("account-color-dot")).toBeNull();
    rerender(<TabAccountMark providerId="p-unknown" providerAccountId="acc-personal" />);
    expect(screen.queryByTestId("account-color-dot")).toBeNull();
    rerender(<TabAccountMark providerId="p-multi" providerAccountId="acc-gone" />);
    expect(screen.queryByTestId("account-color-dot")).toBeNull();
  });
});
