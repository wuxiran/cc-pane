import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const service = vi.hoisted(() => ({ getStatus: vi.fn(), markIncident: vi.fn(), openDirectory: vi.fn() }));
vi.mock("@/services/performanceService", () => ({ performanceService: service }));
vi.mock("@/services/runtime", () => ({ isTauriRuntime: () => true }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import PerformanceDiagnosticsCard from "./PerformanceDiagnosticsCard";

beforeEach(() => {
  vi.resetAllMocks();
  service.getStatus.mockResolvedValue({ running: true, lastError: null });
  service.markIncident.mockResolvedValue(undefined);
  service.openDirectory.mockResolvedValue(undefined);
});
describe("performance records controls", () => {
  it("marks a slowdown and opens the existing records", async () => {
    render(<PerformanceDiagnosticsCard />);
    await screen.findByText("performanceRecording");
    fireEvent.click(screen.getByText("markPerformanceIncident"));
    await screen.findByText("performanceIncidentMarked");
    expect(service.markIncident).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByText("openPerformanceRecords")).not.toBeDisabled());
    fireEvent.click(screen.getByText("openPerformanceRecords"));
    await waitFor(() => expect(service.openDirectory).toHaveBeenCalledTimes(1));
  });
  it("shows recorder failure and disables markers instead of claiming success", async () => {
    service.getStatus.mockResolvedValue({ running: true, lastError: "disk full" });
    render(<PerformanceDiagnosticsCard />);
    expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
    expect(screen.getByText("markPerformanceIncident")).toBeDisabled();
  });
});
