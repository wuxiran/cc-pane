import "@/i18n";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { mockTauriInvoke } from "@/test/utils/mockTauriInvoke";
import { useExplorerSectionsStore } from "@/stores/useExplorerSectionsStore";
import RecentSessionsSection from "./RecentSessionsSection";

function indexEntry(overrides: Record<string, unknown>) {
  return {
    sessionId: "s1", cliTool: "claude", filePath: "", cwd: "/repo/demo", projectPathNorm: "", projectName: "demo",
    workspaceName: null, firstPrompt: "", title: "", lastSummary: "", messageCount: 3, mtimeMs: 0, size: 0,
    source: "local", wslDistro: null, updatedAt: "", ...overrides,
  };
}

describe("RecentSessionsSection", () => {
  const onOpenTerminal = vi.fn();
  const renderSection = () => render(<TooltipProvider><RecentSessionsSection onOpenTerminal={onOpenTerminal} /></TooltipProvider>);

  beforeEach(() => {
    onOpenTerminal.mockClear();
    useExplorerSectionsStore.setState({ recentCollapsed: false });
    mockTauriInvoke({
      refresh_session_index: { rootsScanned: 0, filesSeen: 0, filesParsed: 0, filesSkipped: 0, bytesRead: 0 },
      list_session_index: [
        indexEntry({ sessionId: "old", firstPrompt: "Older terminal session", mtimeMs: Date.parse("2026-05-01T10:00:00Z") }),
        indexEntry({ sessionId: "new", firstPrompt: "Newest terminal session", lastSummary: "Wrapped up the refactor.", mtimeMs: Date.parse("2026-05-03T10:00:00Z") }),
      ],
      list_acp_chat_history: [
        { acpSessionId: "acp-1", engineId: "codex", cwd: "/repo/demo", title: "Agent chat in between", createdAt: 1, updatedAt: Date.parse("2026-05-02T10:00:00Z") },
      ],
    });
  });

  it("lists terminal sessions and agent chats together, newest first, one line each", async () => {
    renderSection();
    await screen.findByText("Newest terminal session");
    await waitFor(() => {
      const rows = Array.from(document.querySelectorAll("[data-session-kind]"));
      expect(rows.map((row) => row.textContent)).toEqual(["Newest terminal session", "Agent chat in between", "Older terminal session"]);
      expect(rows.map((row) => row.getAttribute("data-session-kind"))).toEqual(["cli", "chat", "cli"]);
    });
  });

  it("resumes a terminal session on click", async () => {
    renderSection();
    fireEvent.click(await screen.findByText("Newest terminal session"));
    expect(onOpenTerminal).toHaveBeenCalledWith(expect.objectContaining({ path: "/repo/demo", resumeId: "new" }));
  });

  it("shows the session detail on hover", async () => {
    const user = userEvent.setup();
    renderSection();
    await user.hover(await screen.findByText("Newest terminal session"));
    const card = await screen.findByTestId("recent-session-hover-card");
    expect(card.textContent).toContain("Wrapped up the refactor.");
  });

  it("collapses from the header and remembers it", async () => {
    renderSection();
    await screen.findByText("Newest terminal session");
    fireEvent.click(screen.getByRole("button", { name: /^最近$|^Recent$/ }));
    expect(screen.queryByText("Newest terminal session")).not.toBeInTheDocument();
    expect(useExplorerSectionsStore.getState().recentCollapsed).toBe(true);
  });
});
