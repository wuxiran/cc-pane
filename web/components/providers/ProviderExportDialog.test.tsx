import i18n from "@/i18n";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { providerExportService } from "@/services/providerExportService";
import type { ProviderExportCandidate } from "@/types/providerExport";
import ProviderExportDialog from "./ProviderExportDialog";

vi.mock("@/services/providerExportService", () => ({
  providerExportService: {
    candidates: vi.fn(),
    start: vi.fn(),
    cancel: vi.fn(() => Promise.resolve()),
    status: vi.fn(),
    listen: vi.fn(() => Promise.resolve(() => undefined)),
  },
}));

const candidates: ProviderExportCandidate[] = [
  { id: "relay", name: "My Relay", providerType: "proxy", protocol: "anthropic", baseUrl: "https://relay.example.com", modelCount: 2, hasKey: true },
  { id: "nokey", name: "No Key", providerType: "anthropic", protocol: "anthropic", baseUrl: "https://api.anthropic.com", modelCount: 0, hasKey: false, unsupportedReason: "NO_API_KEY" },
  { id: "bed", name: "Bedrock", providerType: "bedrock", protocol: null, baseUrl: null, modelCount: 0, hasKey: true, unsupportedReason: "UNSUPPORTED_TYPE" },
];

describe("ProviderExportDialog", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
    vi.clearAllMocks();
    vi.mocked(providerExportService.candidates).mockResolvedValue(candidates);
  });

  it("preselects only exportable providers and shows the one-time code", async () => {
    vi.mocked(providerExportService.start).mockResolvedValue({
      code: "482913",
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      providerCount: 1,
    });
    render(<ProviderExportDialog open onClose={() => undefined} />);
    await screen.findByText("My Relay");
    expect(screen.getByText("没有 API Key")).toBeTruthy();
    expect(screen.getByText("该类型不支持在手机直连")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /生成导出码（1）/ }));
    await waitFor(() => expect(providerExportService.start).toHaveBeenCalledWith(["relay"]));
    expect((await screen.findByTestId("provider-export-code")).textContent).toContain("482913");
  });

  it("cancels the pending export when closed", async () => {
    vi.mocked(providerExportService.start).mockResolvedValue({
      code: "000111",
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      providerCount: 1,
    });
    const onClose = vi.fn();
    render(<ProviderExportDialog open onClose={onClose} />);
    await screen.findByText("My Relay");
    fireEvent.click(screen.getByRole("button", { name: /生成导出码/ }));
    await screen.findByTestId("provider-export-code");
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    expect(providerExportService.cancel).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
