import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { TooltipProvider } from "@/components/ui/tooltip";
import { createSystemProvider, type Provider } from "@/types/provider";
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

function renderCard(
  provider: Provider,
  systemProbe?: React.ComponentProps<typeof ProviderCard>["systemProbe"],
) {
  const handlers = {
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onSetDefault: vi.fn(),
    onDuplicate: vi.fn(),
  };
  render(
    <TooltipProvider>
      <ProviderCard provider={provider} systemProbe={systemProbe} {...handlers} />
    </TooltipProvider>,
  );
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

  it("shows an inert default marker instead of the set-default action for the default provider", () => {
    renderCard(makeProvider({ isDefault: true }));
    expect(screen.getByText(i18n.t("settings:defaultBadge"))).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: i18n.t("settings:setAsDefaultBtn") })
    ).not.toBeInTheDocument();
  });

  it("has no launch action — starting a session goes through the global launcher", () => {
    renderCard(makeProvider());
    expect(
      screen.queryByRole("button", { name: new RegExp(i18n.t("settings:launch")) })
    ).not.toBeInTheDocument();
  });

  it("invokes edit/duplicate/delete/set-default callbacks with correct args", async () => {
    const user = userEvent.setup();
    const provider = makeProvider();
    const handlers = renderCard(provider);

    await user.click(screen.getByLabelText(i18n.t("settings:editBtn")));
    expect(handlers.onEdit).toHaveBeenCalledWith(provider);

    await user.click(screen.getByLabelText(i18n.t("settings:duplicate")));
    expect(handlers.onDuplicate).toHaveBeenCalledWith(provider);

    await user.click(
      screen.getByRole("button", { name: i18n.t("settings:setAsDefaultBtn") })
    );
    expect(handlers.onSetDefault).toHaveBeenCalledWith("p-1");

    await user.click(screen.getByLabelText(i18n.t("settings:deleteBtn")));
    expect(handlers.onDelete).toHaveBeenCalledWith("p-1");
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

    await user.click(screen.getByLabelText("Copy URL"));
    expect(writeText).toHaveBeenCalledWith("https://proxy.example.com/v1");
    expect(toast.success).toHaveBeenCalledWith("Copied");
  });

  describe("system environment card", () => {
    it("can be set as default (it is a real, persisted choice)", async () => {
      const user = userEvent.setup();
      const handlers = renderCard(createSystemProvider("System env"), {
        envKeys: [],
        ccSwitch: false,
        runtimeApplicable: true,
      });

      await user.click(
        screen.getByRole("button", { name: i18n.t("settings:setAsDefaultBtn") })
      );
      expect(handlers.onSetDefault).toHaveBeenCalledWith("__system__");
    });

    it("lists the detected variable names and never their values", () => {
      renderCard(createSystemProvider("System env"), {
        envKeys: ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"],
        ccSwitch: true,
        runtimeApplicable: true,
      });

      expect(
        screen.getByText(
          i18n.t("settings:systemEnvDetected", {
            keys: `${i18n.t("settings:systemEnvCcSwitch")}, ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL`,
          })
        )
      ).toBeInTheDocument();
    });

    it("shows the empty-probe message when nothing was detected", () => {
      renderCard(createSystemProvider("System env"), {
        envKeys: [],
        ccSwitch: false,
        runtimeApplicable: true,
      });
      expect(screen.getByText(i18n.t("settings:systemEnvNone"))).toBeInTheDocument();
    });

    it("warns that the host probe does not apply under WSL/SSH", () => {
      renderCard(createSystemProvider("System env"), {
        envKeys: ["ANTHROPIC_API_KEY"],
        ccSwitch: false,
        runtimeApplicable: false,
        runtimeLabel: "WSL",
      });
      expect(
        screen.getByText(i18n.t("settings:systemEnvRuntimeWarning", { runtime: "WSL" }))
      ).toBeInTheDocument();
    });
  });
});
