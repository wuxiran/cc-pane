import "@/i18n";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { confirm } from "@tauri-apps/plugin-dialog";
import { agentChatService } from "@/services/agentChatService";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import type { AcpChatSnapshot } from "@/types/agentChat";
import SessionWorkspaceMenu from "./SessionWorkspaceMenu";

vi.mock("@/services/agentChatService", () => ({ agentChatService: { start: vi.fn() } }));
vi.mock("./StartProjectMenu", () => ({
  default: ({ onPickCwd, trigger }: { onPickCwd: (cwd: string) => void; trigger: React.ReactNode }) => (
    <div>{trigger}<button onClick={() => onPickCwd("/new-project")}>new-project</button><button onClick={() => onPickCwd("/other-project")}>other-project</button></div>
  ),
  workspaceLabelFor: (cwd: string) => cwd,
}));
const CHAT = "workspace-switch-test";
const snapshot: AcpChatSnapshot = { chatId: CHAT, engineId: "claude", phase: "ready", acpSessionId: "old-session" };
beforeEach(() => {
  vi.clearAllMocks();
  useAgentChatStore.getState().dropChat(CHAT);
  useAgentChatStore.getState().setSnapshot(CHAT, snapshot);
  useAgentChatStore.getState().setCwdOverride(CHAT, "/old-project");
  vi.mocked(confirm).mockResolvedValue(true);
});
const renderMenu = () => render(<SessionWorkspaceMenu chatId={CHAT} cwd="/old-project" generating={false} />);

describe("SessionWorkspaceMenu directory transaction", () => {
  it("preserves the real cwd and ready session when the target no longer exists", async () => {
    vi.mocked(agentChatService.start).mockRejectedValue(new Error("ACP_CWD_INVALID"));
    renderMenu();
    await act(async () => fireEvent.click(screen.getByText("new-project")));
    const chat = useAgentChatStore.getState().chats[CHAT];
    expect(chat.cwdOverride).toBe("/old-project");
    expect(chat.snapshot).toEqual(snapshot);
    expect(chat.setup).toBeNull();
    expect(chat.items.filter((item) => item.type === "notice").map((item) => item.text)).toEqual(["ACP_CWD_INVALID"]);
  });

  it("commits only after successful start and excludes overlapping switches across remounts", async () => {
    let finish!: (snapshot: AcpChatSnapshot) => void;
    vi.mocked(agentChatService.start).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const view = renderMenu();
    await act(async () => fireEvent.click(screen.getByText("new-project")));
    expect(useAgentChatStore.getState().chats[CHAT].cwdOverride).toBe("/old-project");
    expect(useAgentChatStore.getState().chats[CHAT].setup?.pending).toBe(true);
    view.unmount(); renderMenu();
    await act(async () => fireEvent.click(screen.getByText("other-project")));
    expect(agentChatService.start).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledTimes(1);
    await act(async () => finish({ ...snapshot, acpSessionId: "new-session" }));
    const chat = useAgentChatStore.getState().chats[CHAT];
    expect(chat.cwdOverride).toBe("/new-project");
    expect(chat.snapshot?.acpSessionId).toBe("new-session");
    expect(chat.setup).toBeNull();
  });

  it("locks before confirmation and releases it if the user declines", async () => {
    let finish!: (answer: boolean) => void;
    vi.mocked(confirm).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    renderMenu();
    fireEvent.click(screen.getByText("new-project"));
    fireEvent.click(screen.getByText("other-project"));
    expect(confirm).toHaveBeenCalledTimes(1);
    await act(async () => finish(false));
    expect(agentChatService.start).not.toHaveBeenCalled();
    expect(useAgentChatStore.getState().chats[CHAT].setup).toBeNull();
    expect(useAgentChatStore.getState().chats[CHAT].cwdOverride).toBe("/old-project");
  });
});
