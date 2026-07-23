import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { usePanesStore } from "@/stores";
import { useOpenTerminal } from "./useOpenTerminal";

vi.mock("sonner", () => ({
  toast: { error: vi.fn() },
}));

describe("useOpenTerminal host path guard", () => {
  beforeEach(() => {
    vi.mocked(toast.error).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("blocks a Windows local path before creating a tab on a non-Windows host", () => {
    vi.spyOn(window.navigator, "platform", "get").mockReturnValue("MacIntel");
    const openProject = vi.fn();
    usePanesStore.setState({ openProject } as never);
    const { result } = renderHook(() => useOpenTerminal());

    act(() => result.current({ path: "D:\\repo", cliTool: "codex" }));

    expect(openProject).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("D:\\repo"));
  });
});
