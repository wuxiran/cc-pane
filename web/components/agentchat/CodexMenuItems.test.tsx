import "@/i18n";
import i18n from "i18next";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { createPanel } from "@/lib/paneTree";
import { usePanesStore } from "@/stores/usePanesStore";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import { codexDesktopService } from "@/services/codexDesktopService";
import { agentChatService } from "@/services/agentChatService";
import type { Tab } from "@/types";
import type { AcpChatSnapshot } from "@/types/agentChat";
import CodexMenuItems from "./CodexMenuItems";

vi.mock("@/services/codexDesktopService", () => ({ codexDesktopService: { open: vi.fn().mockResolvedValue("codex://new") } }));
const tab: Tab = { id: "cli", title: "Codex", contentType: "terminal", projectId: "", projectPath: "/repo", cliTool: "codex", sessionId: "pty", resumeId: "native-id", resumeIdSource: "hook" };

beforeEach(async () => {
  await i18n.changeLanguage("en");
  vi.clearAllMocks(); window.__TAURI_INTERNALS__ = {};
  const panel = createPanel(); panel.tabs = [tab]; panel.activeTabId = tab.id;
  usePanesStore.setState({ rootPane: panel, activePaneId: panel.id, currentLayoutId: "cli-layout", layouts: [{ id: "cli-layout", name: "CLI", rootPane: panel, activePaneId: panel.id }] });
});

function menu(subject = tab, snapshot?: AcpChatSnapshot) {
  return render(<DropdownMenu defaultOpen><DropdownMenuTrigger>More</DropdownMenuTrigger><DropdownMenuContent>
    <CodexMenuItems tab={subject} snapshot={snapshot} menuKind="dropdown" />
  </DropdownMenuContent></DropdownMenu>);
}

describe("Codex session actions", () => {
  it("opens the verified CLI thread", async () => {
    menu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Open in Codex" }));
    await waitFor(() => expect(codexDesktopService.open).toHaveBeenCalledWith({ cwd: "/repo", threadId: "native-id" }));
  });

  it("prepares a separate App Server tab without starting or stopping the CLI", () => {
    const start = vi.spyOn(agentChatService, "start");
    menu();
    fireEvent.click(screen.getByRole("menuitem", { name: "New Codex App Server chat" }));
    const store = usePanesStore.getState();
    const created = store.activePane()!.tabs.find((item) => item.id === store.activePane()!.activeTabId)!;
    expect(created).toMatchObject({ projectPath: "/repo", agentEngineId: "codex-app-server", parentTabId: "cli" });
    expect(store.findTabAcrossLayouts("cli")?.tab.sessionId).toBe("pty");
    expect(useAgentChatStore.getState().chats[created.id]?.snapshot).toBeUndefined();
    expect(start).not.toHaveBeenCalled(); start.mockRestore();
  });

  it("opens an ACP Codex project instead of mistaking its session ID for a thread", async () => {
    menu({ ...tab, contentType: "agent-chat" }, { chatId: tab.id, engineId: "codex", phase: "ready", acpSessionId: "acp-id" });
    fireEvent.click(screen.getByRole("menuitem", { name: "Open in Codex" }));
    await waitFor(() => expect(codexDesktopService.open).toHaveBeenCalledWith({ cwd: "/repo" }));
  });

  it("hides the local-only actions for a remote CLI", () => {
    menu({ ...tab, wsl: { remotePath: "/repo" } });
    expect(screen.queryByRole("menuitem", { name: "Open in Codex" })).not.toBeInTheDocument();
  });
});
