import "@/i18n";
import { render, renderHook, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { formFromProvider } from "@/components/providers/providerFormState";
import { buildProviderPayload } from "@/components/providers/accounts/providerPayload";
import type { ActiveTerminalContext } from "@/hooks/useActiveTerminalSession";
import type { PurityReport } from "@/services";
import { useProvidersStore } from "@/stores";
import { useChannelPurityStore } from "@/stores/useChannelPurityStore";
import { useSessionCostStore } from "@/stores/useSessionCostStore";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { createTestSettings } from "@/test/utils/testData";
import type { Provider } from "@/types/provider";
import type { SessionCostSnapshot } from "@/types/sessionCost";
import ProviderAlertIndicator from "./ProviderAlertIndicator";
import { cacheLowAlert, injectionAlert, useProviderAlerts } from "./providerAlerts";

const purityStatus = vi.hoisted(() => vi.fn());
vi.mock("@/services", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services")>()),
  channelPurityService: { status: purityStatus, start: vi.fn(), cancel: vi.fn(), forget: vi.fn() },
}));
vi.mock("@/services/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/runtime")>()),
  isTauriRuntime: () => true,
}));

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

function snapshot(input: number, read: number, write: number): SessionCostSnapshot {
  return {
    status: "ready",
    costUsd: 1,
    hasUnpricedUsage: false,
    inputTokens: input,
    outputTokens: 1000,
    cacheReadTokens: read,
    cacheWriteTokens: write,
    models: [],
    pricingAsOf: "2026-11-01",
    agentSessionId: "a",
    observedAt: 0,
    diagnosticCode: null,
  };
}

const injected: PurityReport = {
  providerId: "relay",
  accountId: "default",
  protocol: "anthropic",
  host: "relay.test",
  checkedAt: "2026-11-26T08:00:00Z",
  verdict: "injected",
  findings: [],
  models: [],
};

function context(overrides: Partial<ActiveTerminalContext> = {}): ActiveTerminalContext {
  return {
    sessionId: "s1",
    cliTool: "claude",
    ssh: false,
    providerId: "relay",
    providerAccountId: "default",
    modelId: null,
    providerSelection: null,
    launchProfileId: null,
    ...overrides,
  };
}

beforeEach(() => {
  purityStatus.mockReset();
  purityStatus.mockResolvedValue({ job: null, reports: [] });
  useProvidersStore.setState({ providers: [relay] });
  useSettingsStore.setState({ settings: createTestSettings() });
  useChannelPurityStore.setState({ reports: {}, job: null, loaded: true });
  useSessionCostStore.setState({ sessions: new Map() });
});

describe("cacheLowAlert", () => {
  it("提示 token 还少时不判断；够量后读缓存不到三成才提醒", () => {
    expect(cacheLowAlert(snapshot(60_000, 0, 20_000))).toBeNull();
    expect(cacheLowAlert(snapshot(5_000, 180_000, 15_000))).toBeNull();
    const alert = cacheLowAlert(snapshot(150_000, 10_000, 40_000));
    expect(alert?.promptTokens).toBe(200_000);
    expect(alert?.ratio).toBeCloseTo(0.05);
    expect(cacheLowAlert({ ...snapshot(150_000, 0, 0), status: "waiting" })).toBeNull();
  });
});

describe("injectionAlert", () => {
  it("只认结论是注入、且是同一账号的报告", () => {
    expect(injectionAlert(injected, "default")).toBe(injected);
    expect(injectionAlert(injected, "other")).toBeNull();
    expect(injectionAlert({ ...injected, accountId: undefined }, "other")).not.toBeNull();
    expect(injectionAlert({ ...injected, verdict: "suspicious" }, "default")).toBeNull();
  });
});

describe("useProviderAlerts", () => {
  it("默认两个提醒都开，隐私开关关着也照常（只读本地数据）", () => {
    useSessionCostStore.setState({ sessions: new Map([["s1", { snapshot: snapshot(150_000, 0, 0), loading: false, requestId: 1 }]]) });
    useChannelPurityStore.setState({ reports: { relay: injected } });
    const { result } = renderHook(() => useProviderAlerts(context()));
    expect(result.current?.cacheLow).not.toBeNull();
    expect(result.current?.injection).toBe(injected);
  });

  it("在供应商里关掉后不提醒", () => {
    useProvidersStore.setState({ providers: [{ ...relay, alerts: { cacheLow: false, injection: false } }] });
    useSessionCostStore.setState({ sessions: new Map([["s1", { snapshot: snapshot(150_000, 0, 0), loading: false, requestId: 1 }]]) });
    useChannelPurityStore.setState({ reports: { relay: injected } });
    const { result } = renderHook(() => useProviderAlerts(context()));
    expect(result.current?.cacheLow).toBeNull();
    expect(result.current?.injection).toBeNull();
  });

  it("订阅登录账号、SSH、非 Claude/Codex、没有供应商时都不提醒", () => {
    for (const overrides of [
      { providerAccountId: "login" },
      { ssh: true },
      { cliTool: "gemini" },
      { providerId: null },
    ] satisfies Partial<ActiveTerminalContext>[]) {
      const { result } = renderHook(() => useProviderAlerts(context(overrides)));
      expect(result.current).toBeNull();
    }
  });

  it("没加载过检测报告时读一次本地状态", () => {
    useChannelPurityStore.setState({ loaded: false });
    renderHook(() => useProviderAlerts(context()));
    expect(purityStatus).toHaveBeenCalledTimes(1);
  });
});

describe("ProviderAlertIndicator", () => {
  it("状态栏显示缓存比例和注入图标；没有问题时什么都不渲染", () => {
    const { container, rerender } = render(<TooltipProvider><ProviderAlertIndicator terminalContext={context()} /></TooltipProvider>);
    expect(container).toBeEmptyDOMElement();
    useSessionCostStore.setState({ sessions: new Map([["s1", { snapshot: snapshot(150_000, 20_000, 30_000), loading: false, requestId: 1 }]]) });
    useChannelPurityStore.setState({ reports: { relay: injected } });
    rerender(<TooltipProvider><ProviderAlertIndicator terminalContext={context()} /></TooltipProvider>);
    expect(screen.getByTestId("provider-alert-cache")).toHaveTextContent("10%");
    // 隐私里没开检测时只提示，不能点开检测弹窗
    expect(screen.getByTestId("provider-alert-injection")).toBeDisabled();
  });
});

describe("供应商表单的提醒开关", () => {
  it("老供应商没有这一项时按全开回填，保存时带上", () => {
    const form = formFromProvider(relay);
    expect(form.alerts).toEqual({ cacheLow: true, injection: true });
    const payload = buildProviderPayload(
      { ...form, alerts: { cacheLow: false, injection: true } },
      { id: "relay", models: [], isDefault: false, manageAccounts: false },
    );
    expect(payload.alerts).toEqual({ cacheLow: false, injection: true });
  });
});
