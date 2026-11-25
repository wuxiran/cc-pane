import i18n from "@/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { browserImportService } from "@/services/browserImportService";
import BrowserImportSection from "./BrowserImportSection";

vi.mock("@/services/browserImportService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/browserImportService")>();
  return {
    ...actual,
    browserImportService: { listSources: vi.fn(), importCookies: vi.fn() },
  };
});

const listSources = vi.mocked(browserImportService.listSources);
const importCookies = vi.mocked(browserImportService.importCookies);

describe("BrowserImportSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listSources.mockResolvedValue([
      { id: "chrome", name: "Google Chrome", profiles: [{ id: "Default", name: "Personal" }, { id: "Profile 2", name: "Work" }] },
    ]);
  });

  it("imports the first profile and reports cookie and site counts", async () => {
    importCookies.mockResolvedValue({ imported: 42, skipped: 3, failed: 0, domains: 7 });
    render(<BrowserImportSection />);

    const button = await screen.findByRole("button", {
      name: i18n.t("settings:browserImport.importButton", { browser: "Google Chrome" }),
    });
    fireEvent.click(button);

    expect(importCookies).toHaveBeenCalledWith("chrome", "Default");
    expect(await screen.findByRole("status")).toHaveTextContent(
      i18n.t("settings:browserImport.result", { imported: 42, domains: 7 }),
    );
  });

  it("translates a denied keychain prompt into a readable error", async () => {
    importCookies.mockRejectedValue({ code: "BROWSER_IMPORT_KEYCHAIN_DENIED", message: "denied" });
    render(<BrowserImportSection />);

    fireEvent.click(await screen.findByRole("button", {
      name: i18n.t("settings:browserImport.importButton", { browser: "Google Chrome" }),
    }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      i18n.t("settings:browserImport.errors.BROWSER_IMPORT_KEYCHAIN_DENIED"),
    );
  });

  it("shows the unsupported-platform message when listing fails", async () => {
    listSources.mockRejectedValue({ code: "BROWSER_IMPORT_UNSUPPORTED_PLATFORM", message: "nope" });
    render(<BrowserImportSection />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      i18n.t("settings:browserImport.errors.BROWSER_IMPORT_UNSUPPORTED_PLATFORM"),
    );
    expect(importCookies).not.toHaveBeenCalled();
  });
});
