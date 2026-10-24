import "@/i18n";
import i18n from "i18next";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { browserService, type BrowserPageSnapshot } from "@/services/browserService";
import BrowserComputerUsePanel from "./BrowserComputerUsePanel";

vi.mock("@/services/browserService", () => ({ browserService: {
  snapshot: vi.fn(), screenshot: vi.fn(), screenshotUrl: vi.fn((path) => `asset://${path}`),
  fill: vi.fn(), clickElement: vi.fn(), pressKey: vi.fn(), scroll: vi.fn(),
} }));
const snapshot: BrowserPageSnapshot = {
  pageToken: "page-before", url: "https://example.test/", title: "Owned page", text: "Page content",
  truncated: false, viewport: { width: 800, height: 600 }, elements: [
    { id: 1, tag: "input", role: "textbox", name: "Search field", text: "", disabled: false, editable: true, x: 10, y: 10, width: 100, height: 30 },
    { id: 2, tag: "button", role: "button", name: "Search now", text: "Search now", disabled: false, editable: false, x: 120, y: 10, width: 80, height: 30 },
  ],
};
const panel = (tabId = "browser-1", url = snapshot.url) => <TooltipProvider><BrowserComputerUsePanel tabId={tabId} url={url} onClose={vi.fn()} /></TooltipProvider>;
beforeEach(async () => {
  vi.resetAllMocks();
  await i18n.changeLanguage("en");
  vi.mocked(browserService.snapshot).mockResolvedValue(snapshot);
  vi.mocked(browserService.screenshotUrl).mockImplementation((path) => `asset://${path}`);
});

it("reads before acting and refreshes the observed token after filling", async () => {
  render(panel());
  expect(screen.queryByText("Search field")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Read page" }));
  fireEvent.click(await screen.findByText("Search field"));
  fireEvent.change(screen.getByLabelText("Text to enter"), { target: { value: "中文 ' input" } });
  vi.mocked(browserService.snapshot).mockResolvedValue({ ...snapshot, pageToken: "page-after" });
  fireEvent.click(screen.getByRole("button", { name: "Fill field" }));
  await waitFor(() => expect(browserService.fill).toHaveBeenCalledWith("browser-1", "page-before", 1, "中文 ' input"));
  await waitFor(() => expect(screen.getByRole("button", { name: "Scroll down" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Scroll down" }));
  await waitFor(() => expect(browserService.scroll).toHaveBeenCalledWith("browser-1", "page-after", 0, 450));
});

it("clears controls when a token becomes stale instead of repeating the action", async () => {
  render(panel());
  fireEvent.click(screen.getByRole("button", { name: "Read page" }));
  fireEvent.click(await screen.findByText("Search now"));
  vi.mocked(browserService.clickElement).mockRejectedValue(new Error("Page changed; read again"));
  fireEvent.click(screen.getByRole("button", { name: "Click element" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Page changed; read again");
  expect(screen.queryByRole("button", { name: "Click element" })).not.toBeInTheDocument();
  expect(browserService.clickElement).toHaveBeenCalledTimes(1);
});

it("discards late snapshots after navigation or switching browser tabs", async () => {
  let resolve!: (value: BrowserPageSnapshot) => void;
  vi.mocked(browserService.snapshot).mockReturnValue(new Promise((done) => { resolve = done; }));
  const view = render(panel());
  fireEvent.click(screen.getByRole("button", { name: "Read page" }));
  view.rerender(panel("browser-2", "https://other.test/"));
  await act(async () => resolve(snapshot));
  expect(screen.queryByText("Owned page")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Read page" })).toBeEnabled();
});

it("captures the selected browser tab without touching other tabs", async () => {
  vi.mocked(browserService.screenshot).mockResolvedValue("/owned/capture.png");
  render(panel());
  fireEvent.click(screen.getByRole("button", { name: "Screenshot" }));
  const image = await screen.findByRole("img", { name: "Current browser viewport screenshot" });
  expect(image).toHaveAttribute("src", "asset:///owned/capture.png");
  expect(browserService.screenshot).toHaveBeenCalledWith("browser-1");
});

it("keeps observed element selection available as a keyboard button", async () => {
  render(panel());
  fireEvent.click(screen.getByRole("button", { name: "Read page" }));
  const option = await screen.findByRole("button", { name: /Search field/ });
  option.focus();
  await userEvent.keyboard("{Enter}");
  expect(option).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "Fill field" })).toBeEnabled();
  expect(browserService.clickElement).not.toHaveBeenCalled();
});
