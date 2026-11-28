import "@/i18n";
import i18n from "@/i18n";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { magpieService } from "@/services/magpieService";
import type { Provider } from "@/types/provider";
import MagpieQuotaCard from "./MagpieQuotaCard";

vi.mock("@/services/magpieService", () => ({
  magpieService: { getProviderQuotas: vi.fn() },
}));

const getQuotas = vi.mocked(magpieService.getProviderQuotas);

const magpieProvider = {
  id: "magpie-group-code",
  name: "Code · Claude",
  providerType: "anthropic",
  isDefault: false,
  source: { kind: "magpie", externalId: "group:code" },
} as Provider;

describe("MagpieQuotaCard", () => {
  beforeEach(async () => {
    getQuotas.mockReset();
    await i18n.changeLanguage("zh-CN");
  });

  it("lists quota windows for a Magpie provider", async () => {
    getQuotas.mockResolvedValue({
      available: true,
      quotas: [
        {
          provider: "claude",
          name: "a@example.com",
          kind: "subscription",
          plan: "max",
          windows: [
            { name: "5h", used: 62, remaining: 38, unlimited: false, text: false },
            { name: "7d", used: 95, remaining: 5, unlimited: false, text: false },
          ],
          last: true,
        },
        { provider: "deepseek", name: "key", kind: "balance", balance: "$3.20", windows: [], last: false },
      ],
    });
    render(<MagpieQuotaCard provider={magpieProvider} />);
    await waitFor(() => expect(screen.getByTestId("magpie-quota-card")).toBeTruthy());
    const rows = screen.getAllByTestId("magpie-quota-row");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("a@example.com · max");
    expect(rows[0].textContent).toContain("5h 62%");
    expect(rows[1].textContent).toContain("$3.20");
    expect(getQuotas).toHaveBeenCalledWith("magpie-group-code");
  });

  it("renders nothing when Magpie is unavailable", async () => {
    getQuotas.mockResolvedValue({ available: false, quotas: [] });
    const { container } = render(<MagpieQuotaCard provider={magpieProvider} />);
    await waitFor(() => expect(getQuotas).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });

  it("does not ask for providers that cannot point at Magpie", () => {
    render(
      <MagpieQuotaCard
        provider={{ ...magpieProvider, source: null, baseUrl: "https://api.example.com" }}
      />,
    );
    expect(getQuotas).not.toHaveBeenCalled();
  });
});
