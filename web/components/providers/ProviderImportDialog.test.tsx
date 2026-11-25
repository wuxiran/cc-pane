import i18n from "@/i18n";
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { providerService } from "@/services/providerService";
import { useLaunchProfilesStore, useProvidersStore } from "@/stores";
import type { ExternalProviderPreview } from "@/types/provider";
import ProviderImportDialog from "./ProviderImportDialog";

vi.mock("@/services/providerService", () => ({
  providerService: {
    previewExternalProviders: vi.fn(),
  },
}));

const magpiePreview: ExternalProviderPreview = {
  available: true,
  path: "/home/u/.config/magpie/providers.json",
  candidates: [
    {
      key: "magpie:group:code:anthropic",
      name: "Code · Claude",
      providerType: "anthropic",
      baseUrl: "http://127.0.0.1:3425",
      hasKey: true,
      modelCount: 1,
      duplicate: false,
      relay: { kind: "magpie_group", routing: "order", memberCount: 2, note: "路由组 · order · 2 成员 · 依赖 Magpie 网关运行" },
    },
    {
      key: "magpie:group:code:open_ai",
      name: "Code · Codex",
      providerType: "open_ai",
      baseUrl: "http://127.0.0.1:3425/v1",
      hasKey: true,
      modelCount: 1,
      duplicate: false,
      relay: { kind: "magpie_group", routing: "order", memberCount: 2, note: "路由组 · order · 2 成员 · 依赖 Magpie 网关运行" },
    },
  ],
  skippedEmpty: 0,
  skippedUnsupported: 0,
  unsupportedLogins: 3,
};

describe("ProviderImportDialog relays", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
    vi.clearAllMocks();
    useProvidersStore.setState({ providers: [] });
    useLaunchProfilesStore.setState({ profiles: [], loading: false });
  });

  it("shows Magpie routing groups as new rows with routing, member count and gateway note", async () => {
    vi.mocked(providerService.previewExternalProviders).mockResolvedValue(magpiePreview);
    render(<ProviderImportDialog source="magpie" onClose={vi.fn()} />);

    const summaries = await screen.findAllByTestId("import-relay-summary");
    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toHaveTextContent("路由组 · order · 2 成员");
    expect(summaries[0]).toHaveTextContent("依赖 Magpie 网关运行");
    // 新条目默认勾选
    expect(screen.getByRole("button", { name: "导入 2 个" })).toBeEnabled();
    expect(screen.getByText(/3 个登录账号暂不支持导入/)).toBeInTheDocument();
  });

  it("lists cc-switch proxy placeholders as skipped with the reason and shows the proxy row", async () => {
    vi.mocked(providerService.previewExternalProviders).mockResolvedValue({
      available: true,
      path: "/home/u/.cc-switch/cc-switch.db",
      candidates: [
        {
          key: "cc_switch:proxy:claude",
          name: "cc-switch 代理 (Claude)",
          providerType: "anthropic",
          baseUrl: "http://127.0.0.1:15721",
          hasKey: true,
          modelCount: 0,
          duplicate: false,
          relay: { kind: "cc_switch_proxy", routing: "failover", memberCount: 2, note: "依赖 cc-switch 代理运行，故障转移由 cc-switch 处理" },
        },
      ],
      skippedEmpty: 0,
      skippedUnsupported: 0,
      unsupportedLogins: 0,
      skippedItems: [{ name: "Taken over", reason: "skipped: cc-switch 代理占位" }],
    });
    render(<ProviderImportDialog source="cc_switch" onClose={vi.fn()} />);

    const summary = await screen.findByTestId("import-relay-summary");
    expect(summary).toHaveTextContent("本地代理 · 故障转移队列 2 个");
    expect(summary).toHaveTextContent("故障转移由 cc-switch 处理");
    const skipped = screen.getByTestId("import-skipped-items");
    expect(within(skipped).getByText(/Taken over/)).toHaveAttribute("title", "skipped: cc-switch 代理占位");
    expect(skipped).toHaveTextContent("cc-switch 代理占位凭据");
  });
});
