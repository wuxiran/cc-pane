import { describe, expect, it } from "vitest";

import { DEFAULT_LOGIN_ACCOUNT_ID, type Provider } from "@/types/provider";
import { accountColorVar, isSelectableAccount, selectableAccounts } from "./providerAccounts";

function provider(overrides: Partial<Provider>): Provider {
  return {
    id: "p",
    name: "P",
    providerType: "anthropic",
    isDefault: false,
    accounts: [{ id: "default", name: "默认", kind: "api_key", secretStorage: "keychain" }],
    defaultAccountId: "default",
    ...overrides,
  };
}

describe("selectableAccounts", () => {
  it("普通密钥供应商只有一个默认账号，不合成默认登录", () => {
    const accounts = selectableAccounts(provider({}), "claude");
    expect(accounts.map((a) => a.id)).toEqual(["default"]);
    expect(accounts[0].isDefault).toBe(true);
  });

  it("建过该 CLI 的登录账号后，列出默认登录", () => {
    const p = provider({
      accounts: [
        { id: "default", name: "默认", kind: "api_key" },
        { id: "claude-1", name: "个人号", kind: "login", cliTool: "claude", color: "blue" },
      ],
    });
    expect(selectableAccounts(p, "claude").map((a) => a.id)).toEqual([
      "default",
      "claude-1",
      DEFAULT_LOGIN_ACCOUNT_ID,
    ]);
    // 别的 CLI 下登录账号不可选，也不合成默认登录
    expect(selectableAccounts(p, "opencode").map((a) => a.id)).toEqual(["default"]);
  });

  it("Gemini 供应商下 Antigravity 能选密钥账号和自己的登录账号，看不到 Gemini CLI 的登录", () => {
    const p = provider({
      providerType: "gemini",
      accounts: [
        { id: "default", name: "默认", kind: "api_key" },
        { id: "gemini-1", name: "Gemini 号", kind: "login", cliTool: "gemini" },
        { id: "agy-1", name: "反重力号", kind: "login", cliTool: "antigravity" },
      ],
    });
    expect(selectableAccounts(p, "antigravity").map((a) => a.id)).toEqual([
      "default",
      "agy-1",
      DEFAULT_LOGIN_ACCOUNT_ID,
    ]);
    const agyAccounts = selectableAccounts(p, "antigravity");
    expect(agyAccounts[agyAccounts.length - 1]?.cliTool).toBe("antigravity");
    expect(selectableAccounts(p, "gemini").map((a) => a.id)).toEqual([
      "default",
      "gemini-1",
      DEFAULT_LOGIN_ACCOUNT_ID,
    ]);
  });

  it("记住的账号不再可选时判为失效", () => {
    const p = provider({});
    expect(isSelectableAccount(p, "claude", "default")).toBe(true);
    expect(isSelectableAccount(p, "claude", "gone")).toBe(false);
    expect(isSelectableAccount(p, "claude", null)).toBe(false);
  });
});

describe("accountColorVar", () => {
  it("只认 token 颜色名，任意值不画", () => {
    expect(accountColorVar("blue")).toBe("var(--app-tag-blue)");
    expect(accountColorVar("#ff0000")).toBeUndefined();
    expect(accountColorVar(null)).toBeUndefined();
  });
});
