import "@/i18n";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SessionOutputPreview from "./SessionOutputPreview";
import { terminalService } from "@/services";

vi.mock("@/services/terminalService", () => ({
  terminalService: {
    getRecentOutput: vi.fn(),
  },
}));

const getRecentOutput = vi.mocked(terminalService.getRecentOutput);

describe("SessionOutputPreview", () => {
  beforeEach(() => {
    getRecentOutput.mockResolvedValue({ lines: ["line-1", "line-2"] } as never);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("shows the no-session placeholder and never polls without a session id", () => {
    render(<SessionOutputPreview sessionId={null} />);

    expect(screen.getByText("无关联的终端会话")).toBeInTheDocument();
    expect(getRecentOutput).not.toHaveBeenCalled();
  });

  it("loads recent output and joins lines with newlines", async () => {
    render(<SessionOutputPreview sessionId="sess-1" />);

    await waitFor(() => expect(screen.getByText(/line-1/)).toBeInTheDocument());
    expect(getRecentOutput).toHaveBeenCalledWith("sess-1", 200);
    expect(screen.getByText(/line-1/).textContent).toBe("line-1\nline-2");
  });

  it("shows the empty-output placeholder when no lines come back", async () => {
    getRecentOutput.mockResolvedValue({ lines: [] } as never);
    render(<SessionOutputPreview sessionId="sess-1" />);

    await waitFor(() => expect(getRecentOutput).toHaveBeenCalled());
    expect(await screen.findByText("暂无输出")).toBeInTheDocument();
  });

  it("shows the error message when loading fails", async () => {
    getRecentOutput.mockRejectedValue(new Error("pty gone"));
    render(<SessionOutputPreview sessionId="sess-1" />);

    expect(await screen.findByText("pty gone")).toBeInTheDocument();
  });

  it("polls every 3 seconds while mounted and stops after unmount", async () => {
    vi.useFakeTimers();
    const view = render(<SessionOutputPreview sessionId="sess-1" />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(getRecentOutput).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(getRecentOutput).toHaveBeenCalledTimes(2);

    view.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9000);
    });
    expect(getRecentOutput).toHaveBeenCalledTimes(2);
  });

  it("refetches when the session id changes", async () => {
    const view = render(<SessionOutputPreview sessionId="sess-1" />);
    await waitFor(() => expect(getRecentOutput).toHaveBeenCalledWith("sess-1", 200));

    view.rerender(<SessionOutputPreview sessionId="sess-2" />);
    await waitFor(() => expect(getRecentOutput).toHaveBeenCalledWith("sess-2", 200));
  });
});
