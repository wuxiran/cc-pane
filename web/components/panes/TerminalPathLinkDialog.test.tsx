import "@/i18n";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useTerminalPathLinkStore } from "@/stores/useTerminalPathLinkStore";
import { useEditorRevealStore } from "@/stores/useEditorRevealStore";
import { usePanesStore } from "@/stores/usePanesStore";
import TerminalPathLinkDialog from "./TerminalPathLinkDialog";

const isTauriRuntime = vi.hoisted(() => vi.fn(() => true));

vi.mock("@/services/runtime", () => ({ isTauriRuntime }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function setReady(kind: "file" | "directory" = "file", canonicalPath = "C:/repo/src/App.tsx") {
  useTerminalPathLinkStore.setState({
    dialog: {
      phase: "ready",
      requestId: 1,
      sessionId: "s1",
      rawPath: "src/App.tsx",
      canonicalPath,
      kind,
      runtimeKind: "local",
      line: 12,
      column: 8,
    },
    requestSequence: 1,
  });
}

describe("TerminalPathLinkDialog", () => {
  beforeEach(() => {
    isTauriRuntime.mockReturnValue(true);
    useTerminalPathLinkStore.getState().resetForTest();
    useEditorRevealStore.getState().resetForTest();
  });

  it("renders resolving state with the raw path", () => {
    useTerminalPathLinkStore.setState({
      dialog: {
        phase: "resolving",
        requestId: 1,
        sessionId: "s1",
        rawPath: "src/App.tsx",
        line: 12,
        column: 8,
      },
    });

    render(<TerminalPathLinkDialog />);

    expect(screen.getByRole("dialog", { name: /打开终端路径|Open terminal path/i })).toBeInTheDocument();
    expect(screen.getByText("src/App.tsx:12:8")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /在编辑器中打开|Open in editor/i })).not.toBeInTheDocument();
  });

  it("shows file actions on desktop and keeps the full long path", () => {
    const longPath = `C:/repo/${"long-directory/".repeat(20)}App.tsx`;
    setReady("file", longPath);

    render(<TerminalPathLinkDialog />);

    expect(screen.getByText(`${longPath}:12:8`)).toHaveTextContent(`${longPath}:12:8`);
    expect(screen.getByRole("button", { name: /在编辑器中打开|Open in editor/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /使用默认程序打开|Open with default app/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /在文件管理器中显示|Show in file manager/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /复制路径|Copy path/i })).toBeEnabled();
  });

  it("hides desktop actions for a Web directory", () => {
    isTauriRuntime.mockReturnValue(false);
    setReady("directory", "/repo/docs");

    render(<TerminalPathLinkDialog />);

    expect(screen.queryByRole("button", { name: /文件管理器|file manager/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /复制路径|Copy path/i })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /在编辑器中打开|Open in editor/i })).not.toBeInTheDocument();
  });

  it("disables every action while one action is running", () => {
    setReady();
    const current = useTerminalPathLinkStore.getState().dialog;
    if (current.phase !== "ready") throw new Error("ready state expected");
    useTerminalPathLinkStore.setState({
      dialog: { ...current, phase: "acting", pendingAction: "copy" },
    });

    render(<TerminalPathLinkDialog />);

    for (const button of screen.getAllByRole("button")) {
      if (button.getAttribute("data-slot") === "dialog-close") continue;
      expect(button).toBeDisabled();
    }
  });

  it("closes on Escape", async () => {
    setReady();
    render(<TerminalPathLinkDialog />);

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => expect(useTerminalPathLinkStore.getState().dialog.phase).toBe("closed"));
  });

  it("does not submit copy twice while the first clipboard write is pending", async () => {
    const user = userEvent.setup();
    let finish!: () => void;
    const writeText = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    setReady();
    render(<TerminalPathLinkDialog />);
    const button = screen.getByRole("button", { name: /复制路径|Copy path/i });

    await user.click(button);
    fireEvent.click(button);
    expect(writeText).toHaveBeenCalledTimes(1);
    await act(async () => finish());
  });

  it("does not create a Monaco reveal request for image targets", async () => {
    const openEditor = vi.spyOn(usePanesStore.getState(), "openEditor").mockImplementation(() => null);
    setReady("file", "C:/repo/assets/logo.png");
    render(<TerminalPathLinkDialog />);

    const editorButton = screen.getAllByRole("button").find((button) => button.textContent?.includes("编辑器"));
    if (!editorButton) throw new Error("editor action not rendered");
    await userEvent.click(editorButton);

    expect(openEditor).toHaveBeenCalled();
    expect(useEditorRevealStore.getState().requests["C:/repo/assets/logo.png"]).toBeUndefined();
  });
});
