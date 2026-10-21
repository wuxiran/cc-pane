import "@/i18n";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAgentChatStore } from "@/stores/useAgentChatStore";
import type { AcpChatSnapshot } from "@/types/agentChat";
import { loadEnginePrefs } from "./enginePrefs";
import ChatAddMenu from "./ChatAddMenu";

const actions = vi.hoisted(() => ({ openSkillManager: vi.fn(), openMcpConfig: vi.fn() }));
vi.mock("@/stores/usePanesStore", () => ({ usePanesStore: { getState: () => actions } }));
const chatId = "chat-add-menu";
const callbacks = { onFiles: vi.fn().mockResolvedValue(undefined), onFolders: vi.fn().mockResolvedValue(undefined), onProject: vi.fn(), onCapture: vi.fn() };

function snapshot(extra: Partial<AcpChatSnapshot> = {}) {
  useAgentChatStore.getState().setSnapshot(chatId, { chatId, engineId: "codex", phase: "ready", ...extra });
}
function renderMenu(props = {}) {
  return render(<TooltipProvider><ChatAddMenu chatId={chatId} cwd="/repo/demo" phase="ready" generating={false} blocked={false} {...callbacks} {...props} /></TooltipProvider>);
}
async function openMenu() {
  fireEvent.keyDown(screen.getByRole("button", { name: "添加" }), { key: "ArrowDown" });
  await screen.findByRole("menu");
}
const modes = { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }, { id: "plan", name: "Plan" }] };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(invoke).mockResolvedValue(undefined);
  localStorage.clear();
  useAgentChatStore.getState().dropChat(chatId);
  snapshot();
});

describe("ChatAddMenu", () => {
  it("shows only working attachment/tool entries and preserves keyboard focus on Escape", async () => {
    renderMenu();
    await openMenu();
    expect(screen.getByRole("menuitem", { name: "文件" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "文件夹" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitemradio")).not.toBeInTheDocument();
    expect(screen.queryByText("目标")).not.toBeInTheDocument();
    expect(screen.queryByText("录制技能")).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "添加" })).toHaveFocus();
  });

  it.each([
    ["文件", "onFiles"], ["文件夹", "onFolders"], ["附加当前项目 demo", "onProject"], ["截图并附加到对话", "onCapture"],
  ] as const)("runs %s without sending a prompt", async (label, action) => {
    renderMenu();
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: label }));
    expect(callbacks[action]).toHaveBeenCalledOnce();
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([["管理项目技能", "openSkillManager"], ["管理项目 MCP", "openMcpConfig"]] as const)("opens %s for the current project", async (label, action) => {
    renderMenu(); await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: label }));
    expect(actions[action]).toHaveBeenCalledWith("/repo/demo", "demo");
  });

  it("does not show capture or project tools without those capabilities", async () => {
    renderMenu({ cwd: "", onCapture: undefined }); await openMenu();
    expect(screen.queryByRole("menuitem", { name: "截图并附加到对话" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "管理项目技能" })).not.toBeInTheDocument();
  });

  it("switches advertised legacy modes and remembers only successful choices", async () => {
    snapshot({ modes }); renderMenu(); await openMenu();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Plan" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("set_acp_chat_mode", { chatId, modeId: "plan" }));
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    expect(loadEnginePrefs("codex")?.preferredModeId).toBe("plan");
  });

  it("uses advertised config mode values instead of duplicated legacy modes", async () => {
    snapshot({ modes, configOptions: [{ configId: "working-mode", category: "mode", currentValue: "execute", options: [{ value: "execute", name: "Execute" }, { value: "planning", name: "Planning" }] }] });
    renderMenu(); await openMenu();
    expect(screen.queryByRole("menuitemradio", { name: "Plan" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Planning" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("set_acp_chat_config_option", { chatId, configId: "working-mode", value: "planning" }));
    expect(invoke).not.toHaveBeenCalledWith("set_acp_chat_mode", expect.anything());
  });

  it.each([{ generating: true }, { blocked: true }, { phase: "starting" }])("disables switching while busy: %j", async (props) => {
    snapshot({ modes }); renderMenu(props); await openMenu();
    const plan = screen.getByRole("menuitemradio", { name: "Plan" });
    expect(plan).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(plan);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("shows mode failure, retains the current choice and permits retry after the request settles", async () => {
    let reject!: (error: Error) => void;
    vi.mocked(invoke).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    snapshot({ modes }); renderMenu(); await openMenu();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Plan" }));
    expect(screen.getByRole("status")).toHaveTextContent("正在切换模式");
    expect(screen.getByRole("menuitemradio", { name: "Plan" })).toHaveAttribute("aria-disabled", "true");
    await act(async () => reject(new Error("mode denied")));
    expect(screen.getByRole("alert")).toHaveTextContent("mode denied");
    expect(screen.getByRole("menuitemradio", { name: "Default" })).toHaveAttribute("aria-checked", "true");
    expect(loadEnginePrefs("codex")?.preferredModeId).not.toBe("plan");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Plan" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
  });
});
