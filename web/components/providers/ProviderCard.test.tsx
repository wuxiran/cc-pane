import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { Provider } from "@/types/provider";
import ProviderCard from "./ProviderCard";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const { toast } = await import("sonner");

function makeProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: "p-1",
    name: "My Provider",
    providerType: "proxy",
    apiKey: null,
    baseUrl: null,
    region: null,
    projectId: null,
    awsProfile: null,
    configDir: null,
    isDefault: false,
    ...overrides,
  };
}

function renderCard(provider: Provider) {
  const handlers = {
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onSetDefault: vi.fn(),
    onLaunch: vi.fn(),
    onDuplicate: vi.fn(),
  };
  render(<ProviderCard provider={provider} {...handlers} />);
  return handlers;
}

describe("ProviderCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows name and masks a long API key as first6***last3", () => {
    renderCard(makeProvider({ apiKey: "sk-ant-1234567890abc" }));
    expect(screen.getByText("My Provider")).toBeInTheDocument();
    expect(screen.getByText("sk-ant***abc")).toBeInTheDocument();
  });

  it("masks short API keys entirely", () => {
    renderCard(makeProvider({ apiKey: "short" }));
    expect(screen.getByText("***")).toBeInTheDocument();
  });

  it("shows default badge and hides set-default button for the default provider", () => {
    renderCard(makeProvider({ isDefault: true }));
    expect(screen.getByText(i18n.t("settings:defaultBadge"))).toBeInTheDocument();
    expect(
      screen.queryByTitle(i18n.t("settings:setAsDefaultBtn"))
    ).not.toBeInTheDocument();
  });

  it("invokes edit/duplicate/delete/set-default/launch callbacks with correct args", async () => {
    const user = userEvent.setup();
    const provider = makeProvider();
    const handlers = renderCard(provider);

    await user.click(screen.getByTitle(i18n.t("settings:editBtn")));
    expect(handlers.onEdit).toHaveBeenCalledWith(provider);

    await user.click(screen.getByTitle(i18n.t("settings:duplicate")));
    expect(handlers.onDuplicate).toHaveBeenCalledWith(provider);

    await user.click(screen.getByTitle(i18n.t("settings:setAsDefaultBtn")));
    expect(handlers.onSetDefault).toHaveBeenCalledWith("p-1");

    await user.click(screen.getByTitle(i18n.t("settings:deleteBtn")));
    expect(handlers.onDelete).toHaveBeenCalledWith("p-1");

    await user.click(
      screen.getByRole("button", { name: new RegExp(i18n.t("settings:launch")) })
    );
    expect(handlers.onLaunch).toHaveBeenCalledWith("p-1");
  });

  it("copies baseUrl to clipboard when the URL button is clicked", async () => {
    const user = userEvent.setup();
    // 在 userEvent.setup 之后覆盖，避免被其内置 clipboard stub 替换
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    // proxy 类型没有 preset website，baseUrl 走可点击复制按钮分支
    renderCard(makeProvider({ baseUrl: "https://proxy.example.com/v1" }));

    await user.click(screen.getByTitle("Copy URL"));
    expect(writeText).toHaveBeenCalledWith("https://proxy.example.com/v1");
    expect(toast.success).toHaveBeenCalledWith("Copied");
  });
});
