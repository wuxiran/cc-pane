import "@/i18n";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { PurityReport, PurityStatus } from "@/services";
import { useChannelPurityStore } from "@/stores/useChannelPurityStore";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { createTestSettings } from "@/test/utils/testData";
import type { Provider } from "@/types/provider";
import PurityBadge from "./PurityBadge";

const purity = vi.hoisted(() => ({
  status: vi.fn(),
  start: vi.fn(async () => {}),
  cancel: vi.fn(async () => {}),
  forget: vi.fn(async () => {}),
}));
const toastErr = vi.hoisted(() => vi.fn());

vi.mock("@/services", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services")>()),
  channelPurityService: purity,
}));
vi.mock("@/services/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/runtime")>()),
  isTauriRuntime: () => true,
}));
vi.mock("@/lib/feedback", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  toastOk: vi.fn(),
  toastErr,
}));

const tp = (key: string, opts?: Record<string, unknown>) => String(i18n.t(`providers:purity.${key}` as never, opts as never));

function provider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: "relay",
    name: "My Relay",
    providerType: "anthropic",
    isDefault: false,
    endpoints: { anthropic: "https://relay.test" },
    accounts: [{ id: "default", name: "默认", kind: "api_key", secretStorage: "keychain" }],
    defaultAccountId: "default",
    ...overrides,
  } as Provider;
}

const injectedReport: PurityReport = {
  providerId: "relay",
  protocol: "anthropic",
  host: "relay.test",
  checkedAt: "2026-11-26T08:00:00Z",
  verdict: "injected",
  findings: [],
  models: [
    {
      model: "claude-opus-5-5",
      verdict: "injected",
      promptTokens: 16208,
      selfReport: "Claude Opus 5.5 | 2026-01",
      findings: [
        { code: "hidden_prefix", detail: "16208" },
        { code: "echoed_injection", detail: "You are Claude Code, Anthropic's official CLI for Claude." },
      ],
    },
    { model: "claude-sonnet-5-5", verdict: "clean", promptTokens: 8, findings: [] },
  ],
};

function statusWith(overrides: Partial<PurityStatus>): PurityStatus {
  return { job: null, reports: [], ...overrides };
}

beforeEach(() => {
  for (const fn of Object.values(purity)) fn.mockReset();
  purity.start.mockResolvedValue(undefined);
  toastErr.mockClear();
  useChannelPurityStore.setState({ reports: {}, job: null, loaded: false });
  useSettingsStore.setState({ settings: createTestSettings({ privacy: { channelPurity: true } }) });
});

describe("PurityBadge", () => {
  it("设置 → 隐私里没打开时什么都不显示，也不去读检测状态", async () => {
    useSettingsStore.setState({ settings: createTestSettings() });
    purity.status.mockResolvedValue(statusWith({ reports: [injectedReport] }));
    const { container } = render(<PurityBadge provider={provider()} />);
    expect(container).toBeEmptyDOMElement();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(purity.status).not.toHaveBeenCalled();
  });

  it("不能检测的供应商不显示（登录账号、Gemini、没有密钥）", () => {
    purity.status.mockResolvedValue(statusWith({}));
    const { container, rerender } = render(<PurityBadge provider={provider({ accounts: [{ id: "default", name: "x", kind: "login" }] })} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<PurityBadge provider={provider({ providerType: "gemini" })} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<PurityBadge provider={provider({ accounts: [{ id: "default", name: "x", kind: "api_key" }] })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("未检测时点开弹窗，开始检测调后端", async () => {
    purity.status.mockResolvedValue(statusWith({}));
    const user = userEvent.setup();
    render(<PurityBadge provider={provider()} />);
    const badge = await screen.findByTestId("purity-badge");
    expect(badge).toHaveAttribute("data-state", "unchecked");
    expect(badge).toHaveTextContent(tp("verdict.unchecked"));
    await user.click(badge);
    const dialog = await screen.findByTestId("purity-dialog");
    expect(within(dialog).getByText(tp("disclaimer"))).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: tp("start") }));
    // 从卡片点开不指定账号，后端用默认账号
    expect(purity.start).toHaveBeenCalledWith("relay", undefined);
  });

  it("显示每个型号的结论和证据，隐藏前缀写出 token 数、注入原文单独展示", async () => {
    purity.status.mockResolvedValue(statusWith({ reports: [injectedReport] }));
    const user = userEvent.setup();
    render(<PurityBadge provider={provider()} />);
    await waitFor(() => expect(screen.getByTestId("purity-badge")).toHaveAttribute("data-state", "injected"));
    await user.click(screen.getByTestId("purity-badge"));
    const dialog = await screen.findByTestId("purity-dialog");
    const models = within(dialog).getAllByTestId("purity-model");
    expect(models.map((m) => m.getAttribute("data-verdict"))).toEqual(["injected", "clean"]);
    expect(within(models[0]).getByText(tp("finding.hidden_prefix", { detail: "16208" }))).toBeInTheDocument();
    expect(within(models[0]).getByText(/You are Claude Code/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: tp("recheck") })).toBeEnabled();
  });

  it("检测进行中显示进度，可取消；别的供应商在跑时不能再开始", async () => {
    purity.status.mockResolvedValue(statusWith({ job: { providerId: "relay", stage: "running", done: 3, total: 8, currentModel: "claude-opus-5-5" } }));
    const user = userEvent.setup();
    const { unmount } = render(<PurityBadge provider={provider()} />);
    await waitFor(() => expect(screen.getByTestId("purity-badge")).toHaveAttribute("data-state", "running"));
    await user.click(screen.getByTestId("purity-badge"));
    const dialog = await screen.findByTestId("purity-dialog");
    expect(within(dialog).getByRole("status")).toHaveTextContent(tp("running", { done: 3, total: 8 }));
    await user.click(within(dialog).getByRole("button", { name: tp("cancel") }));
    expect(purity.cancel).toHaveBeenCalledTimes(1);
    unmount();

    useChannelPurityStore.setState({ loaded: false });
    purity.status.mockResolvedValue(statusWith({ job: { providerId: "other", stage: "running", done: 1, total: 4 } }));
    render(<PurityBadge provider={provider()} />);
    await waitFor(() => expect(purity.status).toHaveBeenCalled());
    await user.click(screen.getByTestId("purity-badge"));
    expect(await screen.findByRole("button", { name: tp("start") })).toBeDisabled();
  });

  it("后端错误码翻译成提示", async () => {
    purity.status.mockResolvedValue(statusWith({}));
    purity.start.mockRejectedValue({ code: "PURITY_NO_MODELS", message: "PURITY_NO_MODELS" });
    const user = userEvent.setup();
    render(<PurityBadge provider={provider()} />);
    await user.click(await screen.findByTestId("purity-badge"));
    await user.click(await screen.findByRole("button", { name: tp("start") }));
    await waitFor(() => expect(toastErr).toHaveBeenCalledWith(tp("error.PURITY_NO_MODELS")));
  });
});
