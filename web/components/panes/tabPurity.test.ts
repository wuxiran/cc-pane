import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useProvidersStore } from "@/stores";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { createTestSettings } from "@/test/utils/testData";
import type { Tab } from "@/types";
import type { Provider } from "@/types/provider";
import { useTabPurityProvider } from "./tabPurity";

const relay = {
  id: "relay",
  name: "Relay",
  providerType: "anthropic",
  isDefault: false,
  endpoints: { anthropic: "https://relay.test" },
  accounts: [
    { id: "default", name: "默认", kind: "api_key", secretStorage: "keychain" },
    { id: "login", name: "订阅", kind: "login", cliTool: "claude" },
  ],
  defaultAccountId: "default",
} as Provider;

function tab(overrides: Partial<Tab>): Tab {
  return { id: "t1", title: "claude", contentType: "terminal", ...overrides } as Tab;
}

beforeEach(() => {
  useProvidersStore.setState({ providers: [relay] });
  useSettingsStore.setState({ settings: createTestSettings({ privacy: { channelPurity: true } }) });
});

describe("useTabPurityProvider", () => {
  it("CLI 标签用的是可检测的 API key 账号时给出供应商", () => {
    const { result } = renderHook(() => useTabPurityProvider(tab({ providerId: "relay", providerAccountId: "default" })));
    expect(result.current?.id).toBe("relay");
    // 没记账号时按默认账号
    const { result: noAccount } = renderHook(() => useTabPurityProvider(tab({ providerId: "relay" })));
    expect(noAccount.current?.id).toBe("relay");
  });

  it("设置 → 隐私里没打开时不出现", () => {
    useSettingsStore.setState({ settings: createTestSettings() });
    const { result } = renderHook(() => useTabPurityProvider(tab({ providerId: "relay", providerAccountId: "default" })));
    expect(result.current).toBeNull();
  });

  it("登录账号、没记供应商、非终端标签、供应商已删除时不出现", () => {
    const cases: Partial<Tab>[] = [
      { providerId: "relay", providerAccountId: "login" },
      {},
      { contentType: "editor", providerId: "relay" } as Partial<Tab>,
      { providerId: "gone" },
    ];
    for (const overrides of cases) {
      const { result } = renderHook(() => useTabPurityProvider(tab(overrides)));
      expect(result.current).toBeNull();
    }
  });
});
